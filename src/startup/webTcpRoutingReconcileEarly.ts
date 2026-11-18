import { reconcileWebTcpRouting } from './webTcpRoutingReconcile';

// Side-effect module: must be the first import of main.tsx so it is evaluated
// before config/api.ts snapshots the stored routing keys.
reconcileWebTcpRouting();
