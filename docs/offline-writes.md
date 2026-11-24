# Writes from the web UI work offline

The web UI is used from a phone that loses its connection, and from a laptop whose daemon restarts.
Whatever the reader changes must survive that: a reload, a closed tab, or a daemon that answers an
hour later. So the page never writes to the daemon directly. It puts each change into the
**outbox**, which keeps it on the device until the daemon has it.

`pnpm check:offline-writes`, part of `pnpm test`, enforces this. This page is the temporary version;
the documentation fork will fold it into the docs.

## The rule

Every change the reader makes goes into the outbox as a `Change`, never straight to `api.*`.

- **Where it lives:** `packages/ui/src/stores/outbox.ts`.
- **What it does with a change:**
  - keeps it in `localStorage` until the daemon has it, so it survives a reload, a closed tab, or a phone that unloads the page;
  - sends changes one at a time, in the order they were made, with one tab sending for all;
  - when the daemon can't be reached, waits and tries again (1 s, doubling up to 30 s), and also when the browser comes back online;
  - when the daemon refuses a change, shows the failure and loads the chat again.

## Adding a write

1. **Add a case** to the `Change` union in `outbox.ts`, with the ids the request needs.
2. **Give it a subject** in `subjectOf`: the id of the thing it changes. `outbox.isPending(subject)` then tells the page that a change to it hasn't been sent yet.
3. **Send it** in `send`, with the `keepalive` flag the other cases pass, so a change made just before the page closes still goes out.
4. **Merge repeats** in `merge` when only the newest matters, like `reply-draft.save` or `note.reorder`. **Withdraw** in `withdraw` when a delete cancels a create the daemon never got.
5. **Show it at once.** Apply the change to the page's state in `applyChange` in `stores/exploration.ts`. The page then shows it before the daemon answers, and again after a reload, because `applyPending` lays every queued change over the server's copy.
6. **Make the daemon accept a repeat.** The outbox may send a change twice, if the connection drops after the daemon saved it and before the answer arrived.
   - A create carries an id made on the device (`newId('note')` and so on). The daemon looks it up first (`existingRow` in `packages/backend/src/store/store.ts`), and a second create with that id returns what the first one made.
   - A repeated delete gets "not found", and `alreadyDone` in `outbox.ts` counts that as done.
7. **Mark it as unsent.** While offline, show "not sent yet" next to the item, as `NoteItem.vue` and `CommentCard.vue` do with `offline && outbox.isPending(id)`.

## Fields saved while typing

Use `useAutosave` (`packages/ui/src/composables/useAutosave.ts`):

- it saves 1 s after the last change, at least every 5 s while changes keep coming, and when the page goes to the background;
- its save calls `outbox.add`, never `api.*`;
- the reply box (`ReplyBar.vue`) and the comment editor (`CommentEditor.vue`) are the examples to copy.

**A change from another device must not overwrite what is being typed here.** Keep the local value while the field has the focus, while `autosave.isDirty()` is true, or while `outbox.isPending(subject)` is true.

## Decisions and actions that only make sense now

Some writes shouldn't run later by surprise:

- a decision, such as approving a request or deleting a chat;
- an action on something running now, such as stopping an answer or restarting a container.

These go straight to the daemon, but only while it can be reached. Disable the control while `offline` is true, and give it the title `notOffline`. Both come from `packages/ui/src/lib/online.ts`, and `ForkRunStatus.vue` is the example. If the page holds edits to the same item, send them through the outbox first, then the decision.

Each such method is listed in `scripts/check-offline-writes.mjs` under `direct`, with the reason.

## Debt

Some writes still go straight to the daemon, though they should use the outbox: board columns, moving and archiving forks, fork settings, and a few more. `scripts/check-offline-writes.mjs` lists them under `debt`.

- **Don't add to that list.** The check fails for any new direct write.
- **When you move one into the outbox,** take it off the list. The check also fails while a listed method is no longer called directly.

## Tests

Every new write needs an e2e test that goes offline and back, the way `packages/ui/e2e/offline.spec.ts` does with `context.setOffline(true)`:

- the change shows at once while offline;
- it is still there after a reload while still offline;
- once online, it reaches the daemon, and a second browser context sees it.

A decision that is disabled offline gets a test that it is disabled.
