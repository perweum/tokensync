import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./components/Button";
import "./index.css";

const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const label: React.CSSProperties = {
  fontSize: 11,
  color: "#888",
  fontFamily: "monospace",
  width: 120,
  flexShrink: 0,
};

function Preview() {
  return (
    <div
      style={{ padding: 40, background: "#f0f0f0", minHeight: "100vh", fontFamily: "sans-serif" }}
    >
      <h2
        style={{
          marginBottom: 32,
          fontSize: 14,
          fontWeight: 600,
          color: "#444",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}
      >
        Button
      </h2>

      <div style={{ display: "flex", gap: 48 }}>
        <div style={section}>
          <p style={{ ...label, color: "#555", fontWeight: 600, marginBottom: 4 }}>Standard</p>
          <div style={row}>
            <span style={label}>primary</span>
            <Button variant="primary" size="standard">
              Knappetekst
            </Button>
          </div>
          <div style={row}>
            <span style={label}>secondary</span>
            <Button variant="secondary" size="standard">
              Knappetekst
            </Button>
          </div>
          <div style={row}>
            <span style={label}>disabled</span>
            <Button variant="primary" size="standard" disabled>
              Knappetekst
            </Button>
          </div>
        </div>

        <div style={section}>
          <p style={{ ...label, color: "#555", fontWeight: 600, marginBottom: 4 }}>Compact</p>
          <div style={row}>
            <span style={label}>primary</span>
            <Button variant="primary" size="compact">
              Knappetekst
            </Button>
          </div>
          <div style={row}>
            <span style={label}>secondary</span>
            <Button variant="secondary" size="compact">
              Knappetekst
            </Button>
          </div>
          <div style={row}>
            <span style={label}>disabled</span>
            <Button variant="primary" size="compact" disabled>
              Knappetekst
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
