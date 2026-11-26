import { useEffect, useState } from "react";
import { canInstall, install, onInstallAvailability } from "../pwa";

/*
 * The button that installs the app, shown in the header while the browser
 * offers the prompt. It is not rendered at all when there is nothing to
 * install from.
 */
export function InstallButton() {
  const [available, setAvailable] = useState(canInstall());

  useEffect(() => onInstallAvailability(() => setAvailable(canInstall())), []);

  if (!available) return null;

  return (
    <button
      type="button"
      className="install-button"
      onClick={() => void install()}
    >
      Install app
    </button>
  );
}
