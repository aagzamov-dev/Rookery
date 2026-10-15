import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./app/App";
import { startCoreEvents } from "./ipc/events";

startCoreEvents();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
