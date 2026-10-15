import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { api } from "./ipc/api";
import { startCoreEvents } from "./ipc/events";

startCoreEvents();
// Drop anything a previous page load left running (tab leases, terminals, collectors).
void api.frontendReady().catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
