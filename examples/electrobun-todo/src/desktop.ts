import Electrobun from "electrobun/main";

Electrobun.events.on("reopen", () => {
  console.info("Relay activated");
});
