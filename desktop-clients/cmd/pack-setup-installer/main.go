package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type shortcutSpec struct {
	Name string `json:"name"`
	Exe  string `json:"exe"`
}

type setupMeta struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Version    string         `json:"version"`
	Publisher  string         `json:"publisher"`
	FolderName string         `json:"folder_name"`
	MainExe    string         `json:"main_exe"`
	Shortcuts  []shortcutSpec `json:"shortcuts"`
}

type clientConfig struct {
	ServerTCP     string `json:"server_tcp"`
	SuperAdminTCP string `json:"superadmin_tcp"`
	Protocol      string `json:"protocol"`
	MagicHex      string `json:"magic_hex"`
}

func main() {
	baseExe := flag.String("base", "", "path to rtx5-setup-base.exe")
	outExe := flag.String("out", "", "output setup exe path")
	id := flag.String("id", "", "app id (e.g. RTX5-Terminal)")
	title := flag.String("title", "", "app title")
	version := flag.String("version", "1.0.0", "app version")
	folder := flag.String("folder", "", "install folder name")
	mainExe := flag.String("main-exe", "", "main exe filename")
	shortcutName := flag.String("shortcut", "", "shortcut display name")
	serverTCP := flag.String("server-tcp", "51.195.188.172:4443", "primary server tcp")
	superadminTCP := flag.String("superadmin-tcp", "51.195.188.172:9100", "superadmin tcp")
	filesCSV := flag.String("files", "", "comma-separated payload files")
	flag.Parse()

	if *baseExe == "" || *outExe == "" || *id == "" || *title == "" || *folder == "" || *mainExe == "" || *filesCSV == "" {
		fmt.Fprintln(os.Stderr, "missing required flags")
		os.Exit(2)
	}
	if *shortcutName == "" {
		*shortcutName = *title
	}

	baseBytes, err := os.ReadFile(*baseExe)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read base exe: %v\n", err)
		os.Exit(1)
	}

	meta := setupMeta{
		ID:         *id,
		Title:      *title,
		Version:    strings.TrimSpace(*version),
		Publisher:  "RTX5 Trading Technologies",
		FolderName: *folder,
		MainExe:    *mainExe,
		Shortcuts:  []shortcutSpec{{Name: *shortcutName, Exe: *mainExe}},
	}
	cfg := clientConfig{
		ServerTCP:     *serverTCP,
		SuperAdminTCP: *superadminTCP,
		Protocol:      "RTX5-BINARY-TCP-V2",
		MagicHex:      "52545805",
	}

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)

	writeJSONEntry := func(name string, v any) error {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(append(b, '\n'))
		return err
	}

	if err := writeJSONEntry("setup-meta.json", meta); err != nil {
		fmt.Fprintf(os.Stderr, "write setup-meta.json: %v\n", err)
		os.Exit(1)
	}
	if err := writeJSONEntry("client-config.json", cfg); err != nil {
		fmt.Fprintf(os.Stderr, "write client-config.json: %v\n", err)
		os.Exit(1)
	}

	for _, f := range strings.Split(*filesCSV, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		src, err := os.Open(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "open payload %s: %v\n", f, err)
			os.Exit(1)
		}
		w, err := zw.Create(filepath.Base(f))
		if err != nil {
			_ = src.Close()
			fmt.Fprintf(os.Stderr, "zip create %s: %v\n", f, err)
			os.Exit(1)
		}
		if _, err := io.Copy(w, src); err != nil {
			_ = src.Close()
			fmt.Fprintf(os.Stderr, "zip copy %s: %v\n", f, err)
			os.Exit(1)
		}
		_ = src.Close()
	}

	if err := zw.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "zip close: %v\n", err)
		os.Exit(1)
	}

	zipBytes := zipBuf.Bytes()
	var trailer [24]byte
	binary.LittleEndian.PutUint64(trailer[0:8], uint64(len(baseBytes)))
	binary.LittleEndian.PutUint64(trailer[8:16], uint64(len(zipBytes)))
	copy(trailer[16:24], []byte("RTX5SET1"))

	if err := os.MkdirAll(filepath.Dir(*outExe), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir: %v\n", err)
		os.Exit(1)
	}
	out, err := os.OpenFile(*outExe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create output: %v\n", err)
		os.Exit(1)
	}
	defer out.Close()

	if _, err := out.Write(baseBytes); err != nil {
		fmt.Fprintf(os.Stderr, "write base: %v\n", err)
		os.Exit(1)
	}
	if _, err := out.Write(zipBytes); err != nil {
		fmt.Fprintf(os.Stderr, "write zip: %v\n", err)
		os.Exit(1)
	}
	if _, err := out.Write(trailer[:]); err != nil {
		fmt.Fprintf(os.Stderr, "write trailer: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Packed %s (%d bytes)\n", *outExe, len(baseBytes)+len(zipBytes)+24)
}
