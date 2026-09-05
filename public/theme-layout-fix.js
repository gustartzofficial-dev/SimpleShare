/*
 * SimpleShare theme layout stability layer.
 *
 * The compatibility layer deliberately adds controls without touching the
 * transport stack. Its first collapsed-members implementation used one generic
 * grid override, however, which is too aggressive for themes that intentionally
 * have their own window chrome, control rails, bottom bars, or premium shells.
 *
 * This file is loaded AFTER compat.js and restores a small, explicit layout
 * contract for every active theme. It is CSS-only on purpose: refresh, theme
 * switching, WebRTC reconnects, and member-panel toggles cannot race it.
 */

const themeLayoutStyle = document.createElement('style');
themeLayoutStyle.id = 'simpleshare-theme-layout-stability';
themeLayoutStyle.textContent = String.raw`
  /* ------------------------------------------------------------------
     Shared contract
     ------------------------------------------------------------------ */
  #room.room.no-members .people-panel {
    display: none !important;
  }

  /* The normal themes keep topbar/stage as direct room children. Re-assert
     their named areas after compat.js's generic grid-column override. */
  #room.room.no-members:not(.premium-mounted) > .topbar {
    grid-area: top !important;
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
  }
  #room.room.no-members:not(.premium-mounted) > .stage {
    grid-area: stage !important;
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
  }

  /* Desktop layouts are the only place where each theme needs a different
     structural contract. Existing responsive rules remain authoritative. */
  @media (min-width: 901px) {
    /* SimpleShare / default */
    html[data-theme="default"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 54px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="default"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 20px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="default"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 90px !important;
      transform: translateX(-50%) !important;
    }

    /* TeamSpeak 3 - left channel tree disappears cleanly. */
    html[data-theme="teamspeak"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 46px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="teamspeak"] #room.room.no-members > .call-dock,
    html[data-theme="teamspeak"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      transform: translateX(-50%) !important;
    }

    /* iOS Glass - the hidden member tray must not leave an 88px ghost row. */
    html[data-theme="ios"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 62px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="ios"] #room.room.no-members > .stage {
      padding-bottom: 100px !important;
    }
    html[data-theme="ios"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 20px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="ios"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 92px !important;
      transform: translateX(-50%) !important;
    }

    /* Windows XP - preserve the Luna titlebar row. */
    html[data-theme="xp"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 30px 48px minmax(0,1fr) !important;
      grid-template-areas: "chrome" "top" "stage" !important;
    }
    html[data-theme="xp"] #room.room.no-members > .theme-shell-chrome {
      grid-area: chrome !important;
      display: flex !important;
    }
    html[data-theme="xp"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 9px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="xp"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 58px !important;
      transform: translateX(-50%) !important;
    }

    /* Windows 98 - prestige layout. Keep all three native-style rows and the
       sunken work area; only the member column is removed. */
    html[data-theme="win98"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 24px 34px minmax(0,1fr) !important;
      grid-template-areas: "chrome" "top" "stage" !important;
    }
    html[data-theme="win98"] #room.room.no-members > .theme-shell-chrome {
      grid-area: chrome !important;
      display: flex !important;
    }
    html[data-theme="win98"] #room.room.no-members > .stage {
      margin-left: 0 !important;
      margin-right: 0 !important;
    }
    html[data-theme="win98"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 7px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="win98"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 48px !important;
      transform: translateX(-50%) !important;
    }

    /* Old Skype - remove its left people column without retaining the offset. */
    html[data-theme="skype"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 70px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="skype"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 18px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="skype"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 88px !important;
      transform: translateX(-50%) !important;
    }

    /* CRT Terminal - prestige layout. The controls are intentionally a vertical
       command rail, so never let the generic centered-dock rule touch them. */
    html[data-theme="terminal"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 42px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="terminal"] #room.room.no-members > .stage {
      padding: 10px 84px 10px 10px !important;
    }
    html[data-theme="terminal"] #room.room.no-members > .call-dock {
      position: fixed !important;
      left: auto !important;
      right: 10px !important;
      top: auto !important;
      bottom: 50% !important;
      transform: translateY(50%) !important;
      flex-direction: column !important;
    }
    html[data-theme="terminal"] #room.room.no-members > .settings-panel {
      position: fixed !important;
      left: auto !important;
      right: 70px !important;
      top: auto !important;
      bottom: 50% !important;
      transform: translateY(50%) !important;
      width: min(410px, calc(100vw - 104px)) !important;
    }

    /* Mac OS X Aqua - preserve the brushed titlebar row. */
    html[data-theme="aqua"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 28px 52px minmax(0,1fr) !important;
      grid-template-areas: "chrome" "top" "stage" !important;
    }
    html[data-theme="aqua"] #room.room.no-members > .theme-shell-chrome {
      grid-area: chrome !important;
      display: flex !important;
    }
    html[data-theme="aqua"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 18px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="aqua"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 88px !important;
      transform: translateX(-50%) !important;
    }

    /* YouTube 2012 - top chrome remains full width; the old left list vanishes. */
    html[data-theme="youtube"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 54px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="youtube"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 18px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="youtube"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 84px !important;
      transform: translateX(-50%) !important;
    }

    /* Android Holo - member strip is a real bottom row, so remove the row too. */
    html[data-theme="holo"] #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-rows: 56px minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
    }
    html[data-theme="holo"] #room.room.no-members > .stage {
      padding-bottom: 88px !important;
    }
    html[data-theme="holo"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 18px !important;
      transform: translateX(-50%) !important;
    }
    html[data-theme="holo"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 86px !important;
      transform: translateX(-50%) !important;
    }
  }

  /* ------------------------------------------------------------------
     Steam Classic premium shell
     ------------------------------------------------------------------ */
  html[data-theme="steam"] #room.room.no-members.premium-mounted .steam-premium-sidebar {
    display: none !important;
  }
  html[data-theme="steam"] #room.room.no-members.premium-mounted .steam-premium-workspace {
    grid-template-columns: minmax(0,1fr) !important;
  }
  html[data-theme="steam"] #room.room.no-members.premium-mounted .steam-premium-main,
  html[data-theme="steam"] #room.room.no-members.premium-mounted .premium-slot-stage {
    width: 100% !important;
    min-width: 0 !important;
  }
  html[data-theme="steam"] #room.room.no-members.premium-mounted .premium-slot-dock > .call-dock {
    position: relative !important;
    left: auto !important;
    right: auto !important;
    top: auto !important;
    bottom: auto !important;
    transform: none !important;
  }
  html[data-theme="steam"] #room.room.no-members.premium-mounted #settingsPanel {
    left: auto !important;
    right: 18px !important;
    transform: none !important;
  }

  /* ------------------------------------------------------------------
     Prestige-theme component finish
     ------------------------------------------------------------------ */

  /* Windows 98: make every new control look like it belongs to the shell. */
  html[data-theme="win98"] .compat-camera-dock {
    background: #c0c0c0 !important;
    color: #000 !important;
    border: 2px solid !important;
    border-color: #fff #404040 #404040 #fff !important;
    box-shadow: none !important;
  }
  html[data-theme="win98"] .compat-camera-dock:active {
    border-color: #404040 #fff #fff #404040 !important;
  }
  html[data-theme="win98"] .tile > .compat-fullscreen {
    width: 28px !important;
    height: 24px !important;
    min-width: 28px !important;
    top: 5px !important;
    right: 5px !important;
    background: #c0c0c0 !important;
    color: #000 !important;
    border: 2px solid !important;
    border-color: #fff #404040 #404040 #fff !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    opacity: 1 !important;
  }
  html[data-theme="win98"] .tile > .compat-fullscreen:active {
    border-color: #404040 #fff #fff #404040 !important;
    transform: none !important;
  }
  html[data-theme="win98"] .compat-people-bubbles {
    top: 7px !important;
    padding: 4px !important;
    border: 2px solid !important;
    border-color: #fff #404040 #404040 #fff !important;
    background: #c0c0c0 !important;
    box-shadow: 2px 2px 0 #000 !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  html[data-theme="win98"] .compat-person-bubble {
    padding: 3px 7px 3px 3px !important;
    background: #d4d0c8 !important;
    border: 1px solid #808080 !important;
    box-shadow: inset 1px 1px #fff !important;
  }
  html[data-theme="win98"] #settingsPanel {
    width: min(392px, calc(100vw - 24px)) !important;
    padding: 29px 8px 8px !important;
    overflow-x: hidden !important;
  }
  html[data-theme="win98"] #settingsPanel::before {
    content: "SimpleShare Settings";
    position: absolute;
    left: 3px;
    right: 3px;
    top: 3px;
    height: 20px;
    display: flex;
    align-items: center;
    padding: 0 5px;
    background: #000080;
    color: #fff;
    font: 700 12px/1 "MS Sans Serif", Tahoma, sans-serif;
    pointer-events: none;
  }
  html[data-theme="win98"] .compat-pfp-control,
  html[data-theme="win98"] .compat-pfp-button {
    background: #c0c0c0 !important;
    color: #000 !important;
    border: 2px solid !important;
    border-color: #fff #404040 #404040 #fff !important;
    box-shadow: none !important;
  }

  /* CRT: the dock stays a command rail; config stays a terminal window. */
  html[data-theme="terminal"] .compat-camera-dock {
    background: #020704 !important;
    color: #53ff7b !important;
    border: 1px solid #1c6b34 !important;
    box-shadow: 0 0 12px rgba(55,255,120,.10) !important;
  }
  html[data-theme="terminal"] .compat-camera-dock:hover:not(:disabled) {
    background: #37ff78 !important;
    color: #020704 !important;
  }
  html[data-theme="terminal"] .tile > .compat-fullscreen {
    background: #020704 !important;
    color: #53ff7b !important;
    border: 1px solid #1c6b34 !important;
    box-shadow: 0 0 14px rgba(55,255,120,.12) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    opacity: 1 !important;
  }
  html[data-theme="terminal"] .tile > .compat-fullscreen:hover {
    background: #0a351b !important;
    color: #9cffb7 !important;
    transform: none !important;
  }
  html[data-theme="terminal"] .compat-people-bubbles {
    top: 8px !important;
    background: #020704 !important;
    border: 1px solid #1c6b34 !important;
    box-shadow: 0 0 20px rgba(55,255,120,.10) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  html[data-theme="terminal"] .compat-person-bubble {
    background: #06110a !important;
    border-color: #174c2a !important;
  }
  html[data-theme="terminal"] #settingsPanel {
    padding: 39px 14px 14px !important;
    background: #020704 !important;
    border: 1px solid #1c6b34 !important;
    box-shadow: 0 0 26px rgba(55,255,120,.12) !important;
    overflow-x: hidden !important;
  }
  html[data-theme="terminal"] #settingsPanel::before {
    content: "CONFIG://SESSION";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 27px;
    display: flex;
    align-items: center;
    padding: 0 10px;
    border-bottom: 1px solid #1c6b34;
    background: #06110a;
    color: #53ff7b;
    font: 700 11px/1 Consolas, "Courier New", monospace;
    letter-spacing: .12em;
    text-shadow: 0 0 8px rgba(55,255,120,.35);
    pointer-events: none;
  }
  html[data-theme="terminal"] .compat-pfp-control,
  html[data-theme="terminal"] .compat-pfp-button {
    background: #06110a !important;
    color: #9cffb7 !important;
    border-color: #174c2a !important;
  }
  html[data-theme="terminal"] .compat-pfp-button:hover {
    background: #0a351b !important;
  }

  /* XP gets the same care without changing its existing Luna composition. */
  html[data-theme="xp"] .compat-camera-dock {
    background: linear-gradient(#fff,#d6d3c8) !important;
    color: #111 !important;
    border: 1px solid #7f9db9 !important;
  }
  html[data-theme="xp"] .tile > .compat-fullscreen {
    background: linear-gradient(#fff,#d9e8fb) !important;
    color: #123a70 !important;
    border: 1px solid #7f9db9 !important;
    box-shadow: 1px 1px 3px rgba(0,0,0,.28) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  /* Aqua, Steam and the remaining themes get small consistency corrections
     for the new controls without flattening their established visual language. */
  html[data-theme="aqua"] .compat-camera-dock {
    background: linear-gradient(#fff,#cddbe7) !important;
    color: #263746 !important;
    border: 1px solid #8fa3b4 !important;
  }
  html[data-theme="youtube"] .compat-camera-dock {
    background: linear-gradient(#fff,#e9e9e9) !important;
    color: #333 !important;
    border: 1px solid #bbb !important;
  }
  html[data-theme="holo"] .compat-camera-dock {
    background: transparent !important;
    color: #33b5e5 !important;
    border-bottom: 2px solid #33b5e5 !important;
  }

  /* Settings/PFP controls may grow vertically on narrow screens. Never let a
     prestige theme's desktop positioning create a horizontal squeeze. */
  @media (max-width: 900px) {
    html[data-theme="terminal"] #room.room.no-members > .call-dock {
      left: 50% !important;
      right: auto !important;
      bottom: 14px !important;
      transform: translateX(-50%) !important;
      flex-direction: row !important;
    }
    html[data-theme="terminal"] #room.room.no-members > .settings-panel {
      left: 50% !important;
      right: auto !important;
      bottom: 78px !important;
      transform: translateX(-50%) !important;
      width: min(410px, calc(100vw - 24px)) !important;
    }
    html[data-theme="win98"] #settingsPanel {
      width: min(392px, calc(100vw - 16px)) !important;
    }
  }

  @media (max-width: 620px) {
    html[data-theme="steam"] #room.room.no-members.premium-mounted #settingsPanel {
      left: 8px !important;
      right: 8px !important;
      bottom: 70px !important;
      width: auto !important;
      transform: none !important;
    }
  }
`;

document.head.appendChild(themeLayoutStyle);
