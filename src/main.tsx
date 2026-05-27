import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { MotionConfig } from "motion/react";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { system } from "./theme";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChakraProvider value={system}>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <App />
        </ToastProvider>
      </MotionConfig>
    </ChakraProvider>
  </React.StrictMode>,
);
