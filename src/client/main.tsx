import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App.tsx";
import { createQueryClient } from "./query-client.ts";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element missing");
}

// A data router makes `useBlocker` available for the "save failed" navigation
// confirmation in the Smart Collection editor. App still owns the route tree.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);
const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
