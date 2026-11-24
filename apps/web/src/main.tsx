import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Placeholder entry point. The real app shell and router are built in the
 * "Frontend scaffold" task.
 */
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<StrictMode>Mobile Cinema</StrictMode>);
}
