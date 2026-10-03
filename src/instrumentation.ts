import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerMonitoring } = await import("./server/monitoring");
    registerMonitoring();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./server/monitoring");
  const operation = ({ render: "NEXT_RENDER", route: "NEXT_ROUTE", action: "NEXT_ACTION", proxy: "NEXT_PROXY" } as Record<string, string>)[context.routeType] || "NEXT_REQUEST";
  // No request URL, headers, original error message or stack are persisted.
  reportError(error, { operation, kind: "REQUEST_ERROR" });
};
