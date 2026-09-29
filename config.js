/*
 * ThoughtShare configuration
 * ---------------------------------------------------------------
 * This is the ONLY file you need to edit after forking.
 * Everything here is public (it ships to every visitor's browser),
 * so never put secrets in it. The Apps Script URL is safe to share:
 * it can only ADD submissions to your private sheet, never read them.
 */
window.THOUGHTSHARE_CONFIG = {
  // Shown in the header and browser tab
  siteTitle: "ThoughtShare",
  tagline: "An anonymous notice board. Pin a thought — kind, honest, curious, or quiet.",

  // Who runs this board (shown in the footer). Leave "" to hide.
  ownerName: "Tashreef Muhammad",
  ownerUrl: "https://github.com/TashreefMuhammad",

  // Your Google Apps Script Web App URL (ends in /exec).
  // Leave "" and the form will explain that submissions are closed.
  submitEndpoint: "https://script.google.com/macros/s/AKfycby5oUkeeHBcYPGE6pU19Ue6BLGLhWWhDQqNNVnjioxTbCTFR6mEdQQ3PLWivZRj8caP/exec",

  // Where approved thoughts live (relative path — keep as is)
  dataUrl: "data/messages.json",

  // Submission rules (the Apps Script enforces its own limit too)
  minLength: 5,
  maxLength: 600,

  // Seconds a visitor must wait between submissions (per browser)
  cooldownSeconds: 60,

  // How many notes to show before "Show more"
  pageSize: 24,

  // Categories: id is what goes into the JSON and the sheet.
  // color = note paper colour, ink = accent/text colour for its chip.
  // Keep ids lowercase, no spaces. Add, remove or rename freely —
  // then use the same ids in apps-script/Code.gs (CATEGORIES).
  categories: [
    { id: "gratitude",  label: "Gratitude",  color: "#FFF3B0", ink: "#8A6D00" },
    { id: "confession", label: "Confession", color: "#FFD6E0", ink: "#A3264B" },
    { id: "advice",     label: "Advice",     color: "#CDEFE3", ink: "#1D6B52" },
    { id: "rant",       label: "Rant",       color: "#FFD9C2", ink: "#A2461A" },
    { id: "hope",       label: "Hope",       color: "#D6E6FF", ink: "#2A5CA8" },
    { id: "random",     label: "Random",     color: "#E7DDFB", ink: "#5B3FA0" }
  ],

  // Fallback category for anything unknown
  defaultCategory: "random"
};
