import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <App />
      </ToastProvider>
    </MotionConfig>
  </React.StrictMode>,
);
