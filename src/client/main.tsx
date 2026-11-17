import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App.tsx";
import { createQueryClient } from "./query-client.ts";
import "@mantine/core/styles.css";
import "./styles.css";

// The v1 contract keeps the dark appearance. Mantine supplies the component
// styling; the remaining stylesheet keeps only shell layout. Theme variables
// are normally injected through a runtime <style> tag, which the strict CSP
// blocks, so styles.css restates these font tokens in its CSP bridge.
const FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_FAMILY_MONOSPACE =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const theme = createTheme({
  primaryColor: "yellow",
  primaryShade: { light: 5, dark: 5 },
  defaultRadius: "md",
  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: FONT_FAMILY_MONOSPACE,
  headings: { fontFamily: FONT_FAMILY },
  // Yellow is a light primary; dark labels keep AA contrast on filled controls.
  autoContrast: true,
});

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
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
