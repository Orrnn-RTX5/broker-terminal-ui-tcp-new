import { captureWebTerminalSsoAtStartup } from './webTerminalSso';

// Side-effect module: must be the first import of main.tsx. index.html has already
// removed the token from the URL fragment. This only moves the parked value into
// module state.
captureWebTerminalSsoAtStartup();
