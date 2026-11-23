# The iOS journey

`scripts/mobile-ios-journey.sh` runs what a person does with the phone app, on a real iPhone or a simulator, against the dev host, and fails naming the first step that did not happen. It drives only `ai.mopilot.phone`, through WebDriverAgent (`scripts/mobile-ios-wda.sh`), and writes a screenshot after every step.

## Run it

1. The app is built for the device (`scripts/mobile-ios-device.sh`) and served by a Metro started with `MOPILOT_DEV_HOST=<the dev host's address>` (and, for a full-signed build, the same `MOPILOT_APPLE_TEAM_ID` as the build).
2. WebDriverAgent runs on the target: `scripts/mobile-ios-wda.sh run <udid>` for a phone (it prints the address). For a simulator that script does not apply (it builds for a device): start the WebDriverAgent test runner on the simulator yourself and pass its address.
3. `scripts/mobile-ios-journey.sh host start` starts a dev host with `--ask`, so the journey can compare the safety number on both screens before it answers `y`. Push settings pass through the environment (`PUSH_MODE`, `APNS_*`). Restart the host before a run to get its seeded chats back.
4. `MOPILOT_WDA_BASE=<url> MOPILOT_METRO=http://<this Mac>:8081 scripts/mobile-ios-journey.sh sim` (or `MOPILOT_IOS_UDID=<udid> scripts/mobile-ios-journey.sh phone`). `--only a,b` runs some steps, `--list` names them, `--out <dir>` says where the screenshots go.

The exit status is 0 when every step passed, 1 naming the failed step, 2 for a wrong call or when the journey could not run (WebDriverAgent unreachable, the host not reading).

It touches only `ai.mopilot.phone`: a tap, swipe or typing is refused unless that app is in front, and an alert is accepted only when its text names MoPilot (the dev client's open prompt, the sign-in consent, the notification permission); on a device the consent belongs to SpringBoard, so it is read through a session bound to no app and answered by a tap on its Continue button.

## What it covers

Launch and sign-out, sign-in, pairing with the safety-number compare, the chat list (grouping, search), a chat with its approval card, Changes and the diff, the terminal, the live view, sending a message, a plan, a new chat, Settings and notifications, background and foreground, a kill and relaunch that connects by itself, the Mac dropping off and coming back, paging through many chats, and revoking and pairing again. The steps are in `scripts/mobile-ios-journey/steps.mjs`; they use the app's accessibility labels, so a renamed label fails the step that uses it, which is the point.

## Things that bite

- A dev client's floating gear sits over the top right and takes taps meant for the buttons beside it: the runner taps near an element's top-left corner.
- WebDriverAgent sees only what is on screen: a list's last row needs a scroll (`scrollTo`).
- Labels are matched with their capitals (`, Connected` must not match "Your chats, connected to your computer.").
- A pairing code is replaced by the next `r`, and by `--renew`: the journey's host runs without it and takes only a code written after its own request.
- The runner's own unit tests (`tests/mobileIosJourney.test.ts`, `tests/mobileIosJourneyWda.test.ts`) run every step against a stub, so a step that calls something that does not exist fails there.
