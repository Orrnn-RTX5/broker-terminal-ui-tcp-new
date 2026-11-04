package rtx5tcp

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func startMockRTOOrderGateway(tb testing.TB) (addr string, acceptedConns *atomic.Int32, cleanup func()) {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	var conns atomic.Int32
	go func() {
		for {
			conn, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			if tc, ok := conn.(*net.TCPConn); ok {
				_ = tc.SetNoDelay(true)
			}
			conns.Add(1)
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReaderSize(c, 64*1024)
				var hdr [RTOFrameHeaderSize]byte
				writeBuf := make([]byte, 0, 512)
				for {
					if _, rerr := io.ReadFull(br, hdr[:]); rerr != nil {
						return
					}
					if hdr[0] != 'R' || hdr[1] != 'T' || hdr[2] != 'O' {
						return
					}
					op := hdr[3]
					reqID := binary.LittleEndian.Uint32(hdr[4:8])
					pLen := binary.LittleEndian.Uint32(hdr[8:12])
					payload := make([]byte, pLen)
					if pLen > 0 {
						if _, rerr := io.ReadFull(br, payload); rerr != nil {
							return
						}
					}
					if op != RTOOpBinaryOrder {
						return
					}
					var req BinaryOrderFastReq
					var resp BinaryOrderFastResp
					if derr := DecodeBinaryOrderFastReqInto(payload, &req); derr != nil {
						resp = BinaryOrderFastResp{
							Status:    BinaryOrderStatusBadRequest,
							ErrorCode: "DECODE_ERR",
							Message:   derr.Error(),
						}
					} else if req.AuthToken == "" {
						resp = BinaryOrderFastResp{
							Action:    req.Action,
							Status:    BinaryOrderStatusUnauthorized,
							Symbol:    req.Symbol,
							ErrorCode: "UNAUTHORIZED",
							Message:   "missing token",
						}
					} else {
						ticket := req.Ticket
						if ticket <= 0 {
							ticket = 900000 + int64(reqID)
						}
						resp = BinaryOrderFastResp{
							Action:         req.Action,
							Status:         BinaryOrderStatusOK,
							ExecMicros:     18,
							OrderTicket:    ticket,
							PositionTicket: ticket,
							DealTicket:     ticket + 100000,
							FillPrice:      1.08545,
							Volume:         req.Volume,
							SL:             req.SL,
							TP:             req.TP,
							Symbol:         req.Symbol,
							ClientOrderID:  req.ClientOrderID,
						}
					}
					writeBuf = writeBuf[:RTOFrameHeaderSize]
					writeBuf[0] = 'R'
					writeBuf[1] = 'T'
					writeBuf[2] = 'O'
					writeBuf[3] = RTOOpBinaryOrder
					binary.LittleEndian.PutUint32(writeBuf[4:8], reqID)
					writeBuf = AppendBinaryOrderFastResp(writeBuf, resp)
					binary.LittleEndian.PutUint32(writeBuf[8:12], uint32(len(writeBuf)-RTOFrameHeaderSize))
					if _, werr := c.Write(writeBuf); werr != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().String(), &conns, func() {
		_ = ln.Close()
	}
}

func startMockOrderMuxServer(tb testing.TB, gate func() (bool, string)) (addr string, cleanup func()) {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	go func() {
		for {
			raw, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				tc, herr := AcceptTunnel(c, 5*time.Second)
				if herr != nil {
					_ = c.Close()
					return
				}
				sess := NewMuxSession(tc, true, nil, nil)
				if gate != nil {
					sess.SetBinaryOrderGate(gate)
				}
				_ = sess.ServeLoop()
			}(raw)
		}
	}()
	return ln.Addr().String(), func() {
		_ = ln.Close()
	}
}

func TestSendBinaryOrderRawAndParity(t *testing.T) {
	prevGW := GetDefaultBinaryOrderGatewayAddr()
	t.Cleanup(func() {
		SetDefaultBinaryOrderGatewayAddr(prevGW)
	})

	gwAddr, gwConns, closeGW := startMockRTOOrderGateway(t)
	defer closeGW()

	SetDefaultBinaryOrderGatewayAddr(gwAddr)
	PrewarmBinaryOrderGatewayPool()

	warmedSlots := 0
	for i := 0; i < rawBinaryGatewayPrewarmConns; i++ {
		rawBinaryGatewayPool.slots[i].mu.RLock()
		act := rawBinaryGatewayPool.slots[i].active
		rawBinaryGatewayPool.slots[i].mu.RUnlock()
		if act != nil && !act.closed.Load() && act.addr == gwAddr {
			warmedSlots++
		}
	}
	if warmedSlots < rawBinaryGatewayPrewarmConns {
		t.Fatalf("expected %d prewarmed pool slots, got %d", rawBinaryGatewayPrewarmConns, warmedSlots)
	}
	deadline := time.Now().Add(250 * time.Millisecond)
	for gwConns.Load() < rawBinaryGatewayPrewarmConns && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := gwConns.Load(); got < rawBinaryGatewayPrewarmConns {
		t.Fatalf("expected at least %d prewarmed gateway sockets accepted, got %d", rawBinaryGatewayPrewarmConns, got)
	}

	var gateAllowed atomic.Bool
	gateAllowed.Store(true)
	muxAddr, closeMux := startMockOrderMuxServer(t, func() (bool, string) {
		if !gateAllowed.Load() {
			return false, "Broker ExecutionLease inactive: revoked"
		}
		return true, ""
	})
	defer closeMux()

	tc, err := DialTunnel(muxAddr, RoleTraderOrderFastLane, 5*time.Second)
	if err != nil {
		t.Fatalf("DialTunnel failed: %v", err)
	}
	clientSess := NewMuxSession(tc, false, nil, nil)
	go clientSess.ServeLoop()
	defer clientSess.Close()

	req := BinaryOrderFastReq{
		Action:       BinaryOrderActionPlaceMarket,
		Side:         BinaryOrderSideBuy,
		Flags:        BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin: 200074,
		Ticket:       777123,
		Volume:       0.25,
		SL:           1.08000,
		TP:           1.09200,
		Symbol:       PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-parity-001"),
		AuthToken:    "jwt-fastlane-token-xyz",
	}

	respStruct, err := clientSess.SendBinaryOrder(req, 5*time.Second)
	if err != nil {
		t.Fatalf("SendBinaryOrder failed: %v", err)
	}
	if respStruct.Status != BinaryOrderStatusOK || respStruct.OrderTicket != 777123 || respStruct.SymbolString() != "EURUSD" {
		t.Fatalf("unexpected SendBinaryOrder resp: %+v", respStruct)
	}

	rawReq := EncodeBinaryOrderFastReq(req)
	rawResp, err := clientSess.SendBinaryOrderRaw(rawReq, 5*time.Second)
	if err != nil {
		t.Fatalf("SendBinaryOrderRaw failed: %v", err)
	}
	expectedRawResp := EncodeBinaryOrderFastResp(respStruct)
	if !bytes.Equal(rawResp, expectedRawResp) {
		t.Fatalf("SendBinaryOrderRaw parity mismatch:\ngot:  %x\nwant: %x", rawResp, expectedRawResp)
	}

	// Verify 64 concurrent pipelined orders across the 32-slot rawBinaryGatewayPool
	const burst = 64
	var wg sync.WaitGroup
	errCh := make(chan error, burst)
	for i := 0; i < burst; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			r := req
			r.Ticket = int64(880000 + idx)
			r.SetClientOrderID(fmt.Sprintf("burst-%03d", idx))
			rawOut, serr := clientSess.SendBinaryOrderRaw(EncodeBinaryOrderFastReq(r), 5*time.Second)
			if serr != nil {
				errCh <- serr
				return
			}
			dec, derr := DecodeBinaryOrderFastResp(rawOut)
			if derr != nil {
				errCh <- derr
				return
			}
			if dec.Status != BinaryOrderStatusOK || dec.OrderTicket != int64(880000+idx) || dec.ClientOrderIDString() != fmt.Sprintf("burst-%03d", idx) {
				errCh <- fmt.Errorf("idx %d mismatched response: %+v", idx, dec)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for e := range errCh {
		t.Fatalf("concurrent burst error: %v", e)
	}

	// Verify atomic lease gate rejection flows cleanly through SendBinaryOrderRaw
	gateAllowed.Store(false)
	rejRaw, err := clientSess.SendBinaryOrderRaw(rawReq, 5*time.Second)
	if err != nil {
		t.Fatalf("SendBinaryOrderRaw on gate reject failed: %v", err)
	}
	rejResp, err := DecodeBinaryOrderFastResp(rejRaw)
	if err != nil {
		t.Fatalf("DecodeBinaryOrderFastResp failed: %v", err)
	}
	if rejResp.Status != 503 || rejResp.ErrorCode != "LEASE_INACTIVE" {
		t.Fatalf("expected 503 LEASE_INACTIVE, got %+v", rejResp)
	}
}

func BenchmarkSendBinaryOrderRawLoopback(b *testing.B) {
	prevGW := GetDefaultBinaryOrderGatewayAddr()
	b.Cleanup(func() {
		SetDefaultBinaryOrderGatewayAddr(prevGW)
	})

	gwAddr, _, closeGW := startMockRTOOrderGateway(b)
	defer closeGW()
	SetDefaultBinaryOrderGatewayAddr(gwAddr)
	PrewarmBinaryOrderGatewayPool()

	muxAddr, closeMux := startMockOrderMuxServer(b, func() (bool, string) { return true, "" })
	defer closeMux()

	tc, err := DialTunnel(muxAddr, RoleTraderOrderFastLane, 5*time.Second)
	if err != nil {
		b.Fatal(err)
	}
	clientSess := NewMuxSession(tc, false, nil, nil)
	go clientSess.ServeLoop()
	defer clientSess.Close()

	rawReq := EncodeBinaryOrderFastReq(BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		Symbol:        PackBinarySymbol("XAUUSD"),
		ClientOrderID: PackBinaryClientOrderID("bench-raw-001"),
		AuthToken:     "jwt-bench-token-1234567890",
	})

	// Warmup
	for i := 0; i < 16; i++ {
		if _, err := clientSess.SendBinaryOrderRaw(rawReq, 5*time.Second); err != nil {
			b.Fatal(err)
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	start := time.Now()
	for i := 0; i < b.N; i++ {
		resp, err := clientSess.SendBinaryOrderRaw(rawReq, 5*time.Second)
		if err != nil || len(resp) < BinaryOrderFastRespHeaderSize+4 {
			b.Fatalf("iter %d failed: err=%v len=%d", i, err, len(resp))
		}
	}
	elapsed := time.Since(start)
	b.ReportMetric(float64(elapsed.Microseconds())/float64(b.N), "us/order")
}
