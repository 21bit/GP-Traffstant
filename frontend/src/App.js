import React, { useEffect } from "react";
import { LanguageProvider } from "./LanguageContext";
import { AuthProvider } from "./AuthContext";
import TripPlanner from "./components/planner/TripPlanner";
import "./App.css";

const globalResetStyle = {
  margin: 0,
  padding: 0,
  overflow: "hidden",
  height: "100dvh",
  width: "100vw",
  display: "flex",
};

function App() {
  useEffect(() => {
    document.title = "Traffstant";
  }, []);

  return (
    <LanguageProvider>
      <AuthProvider>
        <div style={globalResetStyle}>
          <TripPlanner />
        </div>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;
