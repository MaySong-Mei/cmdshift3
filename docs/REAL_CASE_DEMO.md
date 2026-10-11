# CmdShift3 real collaboration demo

Follow one actual delivery: DeepSeek organizes a screenshot and work note into a draft, and reviewed work survives an AI failure. The demo turns that delivery into a team review, an explicit blocker resolution, and a progress summary with evidence.

May and Gary are **demo roles** operated by us. The feature and its tests are real; Gary’s participation is simulated. Use the existing CmdShift3 project at [Dashboard](http://127.0.0.1:4317/), with `may-demo` and `gary-demo` in separate tabs.

## Try the prepared case now

The case is already populated in the live CmdShift3 project. Sign in as May and find these two records, whose titles begin with **Real case**:

| Record | What to inspect | Work Git SHA |
|---|---|---|
| Real case: AI draft handoff is ready for review | Reviewed English draft, annotation, original blocker, and Gary’s review comment | `4aa5fe7` |
| Real case: Handoff approved — all four checks passed | Actual test report, approval, and explicit blocker resolution | `d99adb7` |

Current state has no open blockers, and **Record this real-case demo after review** remains next. Choose **Catch me up** to see the delivery and review since May’s demonstration checkpoint. Opening it keeps the case unread until you choose **Mark seen**.

Suggested spoken line: “May delivered the work with evidence. Gary reviewed it and explicitly closed the approval blocker. When May returned, the project showed what changed and what still needed doing.”

## May delivers the work

**0:00–1:00.** As May, upload a screenshot of the actual draft screen, mark the relevant fields, and add this note:

```text
DeepSeek now organizes a screenshot and work note into a structured draft. If AI is unavailable, the reviewed title, fields, and selected resolution references are preserved for manual review. All four browser draft tests passed. This demo case is waiting for Gary's review. Next: record the demo video.
```

Choose **Prepare draft**, inspect the result, and confirm that the review requirement appears as a blocker. Keep “record the demo video” as the next step. Choose **Commit work** only after reviewing the fields.

**Visible result:** a May record containing the screenshot, annotations, structured deliverable, and Git SHA. The project shows the case’s review blocker. Gary’s tab receives the update.

## Gary reviews and closes the blocker

**1:00–2:00.** As Gary, open May’s record and inspect its screenshot and fields. Add this comment:

```text
Demo review: I checked the draft evidence and the four passing browser draft tests. Reviewed content is retained during simulated AI failures. This case is approved.
```

Create a review Work Commit with a screenshot of the actual test results and this note:

```text
I completed the demo review of screenshot and note organization and safe draft fallback. The four browser draft tests passed. The review blocker for this case is resolved.
```

Inspect the draft. Put the completed review in **Shipped**, then explicitly select **only this case’s review blocker** for resolution. Keep the existing video task without adding a duplicate. Confirm the commit.

**Visible result:** a Gary review record with its own Git SHA. The case’s blocker disappears from current project state; May’s original record and the review comment remain accessible.

## May catches up

**2:00–3:00.** Return to May’s tab and choose **Catch me up**. Read the delivery and review updates, open their source records, and compare the screenshots and Git SHAs. Confirm the updates as seen when ready.

**Visible result:** the summary identifies the completed work and Gary’s demo review. The case is approved, and recording the demo video remains the next step. May’s seen position is independent of Gary’s.

Catch-up covers confirmed Work Commits since each role’s last explicit checkpoint. Older unread work may also appear. Comments remain in the record’s discussion; they are not included in the current AI catch-up input.

## What this demo proves

The four browser draft tests passed and cover retention of reviewed fields, title, and resolution references during simulated AI unavailability. They also check manual fallback and successful organization. These tests simulate failures; they do not establish a live DeepSeek outage.

Every confirmed Work Commit creates a real Git commit, synchronized to the project’s **local Git origin**. A screenshot shows the captured interface; the test output supplies the behavioral evidence. This walkthrough uses web screenshot upload and does not certify the native shortcut capture flow.

For a replay, keep the existing history and create fresh records with a new case title. The app assigns new commit and item identities. Resolve only the blocker created for that run, and leave unrelated older items untouched.

The supplied evidence includes the reviewed draft, a report generated from the actual four-test run, screenshots before and after approval, the discussion, and a validation JSON containing both full Work Git SHAs. These Work Git SHAs belong to the local project history, rather than the application’s source-code repository.
