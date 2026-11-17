import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App.tsx";
import { createQueryClient } from "./query-client.ts";
import { theme } from "./theme.ts";
import "@mantine/core/styles.css";
import "./theme.generated.css";
import "./styles.css";

// The v1 contract keeps the dark appearance. Mantine supplies the component
// styling; the remaining stylesheet keeps only shell layout. The theme
// variables are generated at build time, so the provider injects no <style>
// element that the strict CSP would block.
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
    <MantineProvider
      theme={theme}
      defaultColorScheme="dark"
      forceColorScheme="dark"
      withCssVariables={false}
      withGlobalClasses={false}
    >
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
