// Execute with the production Deno permissions and existing cached dependency.
// No tracing request, provider request or customer content is used.
import { traceable } from "npm:langsmith@0.11.0/traceable";

let calls = 0;
globalThis.fetch = () => {
  calls++;
  throw new Error("UNEXPECTED_EXTERNAL_TRACE_CALL");
};
let denied = false;
try {
  Deno.statSync("/deno/.langsmith/config.json");
} catch (error) {
  denied = error instanceof Error && ["NotCapable", "PermissionDenied"].includes(error.name);
}
if (!denied) throw new Error("HOME_PROFILE_PERMISSION_WAS_BROADENED");
const value = await traceable(async () => 42, {
  name: "restricted-local-graph-smoke",
  tracingEnabled: false,
})();
if (value !== 42 || calls !== 0) throw new Error("LOCAL_GRAPH_SMOKE_FAILED");
console.log(JSON.stringify({
  local_graph: "passed",
  home_profile_read_denied: true,
  outbound_trace_calls: calls,
}));
