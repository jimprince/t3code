# Review Screen Profiling

Use this when the mobile review screen is slow or crashes while opening large diffs.

## Preferred Capture: React Native DevTools Performance

This app is on Expo SDK 55 / React Native 0.83 with Hermes, so the best first trace is the React Native DevTools Performance recording. The review screen also emits `t3.review.*` user timing marks in development builds so the trace can show parse, list-building, row indexing, and syntax-highlighting work.

1. Start the development client:

   ```sh
   cd apps/mobile
   bun dev:client
   ```

2. Open the app in the iOS Simulator or on the device using the development client.

3. In the terminal running Expo, press `j` to open React Native DevTools.

4. In DevTools, open the `Performance` panel.

5. Start recording.

6. In the app, reproduce the slow path:
   - Navigate to the thread.
   - Open `Files Changed`.
   - Select the largest review source.
   - Expand a few large files or tap `Load diff`.
   - Scroll until the app is clearly slow or until just before it crashes.

7. Stop recording.

8. Export or save the Performance recording as a JSON trace.

Send that exported trace file here. Also include the device/simulator model and whether it was iOS or Android.

## Android Fallback: Hermes Sampling Profile

Use this if the app crashes before DevTools can export a trace, or if we need deeper JavaScript stack samples.

1. Run Android dev client:

   ```sh
   cd apps/mobile
   bun android:dev
   bun dev:client
   ```

2. Open the developer menu from the Expo terminal with `d`.

3. Select `Enable Sampling Profiler`.

4. Reproduce the review-screen slowdown.

5. Open the developer menu again with `d`.

6. Select `Disable Sampling Profiler`.

7. Pull and convert the Hermes profile:

   ```sh
   cd apps/mobile
   mkdir -p profiles/review
   bunx react-native profile-hermes profiles/review
   ```

8. Send the generated Chrome trace/profile file from `apps/mobile/profiles/review`.

For the development app variant, the Android package is `com.t3tools.t3code.dev`.

## What To Capture

For the first trace, do not optimize the repro. We want the slowest realistic case:

- A diff with many files and large line counts.
- At least one `Load diff` action for a suppressed large diff.
- One vertical scroll pass after the content appears.
- One horizontal scroll of a long file, if that is part of the slowdown.

If the app crashes, note the last visible action before the crash and attach device logs if available.
