import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ReloadPrompt from "./components/ReloadPrompt";
import { LanguageProvider } from "./lib/i18n";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
      <ReloadPrompt />
    </LanguageProvider>
  </StrictMode>,
);
