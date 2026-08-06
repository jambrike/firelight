import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/vt323/latin-400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRouter } from "./app/routes";
import "./styles/index.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Firelight could not find its application root.");
}

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
