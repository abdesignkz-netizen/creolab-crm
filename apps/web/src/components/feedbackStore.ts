export type Feedback = {
  id: string;
  message: string;
  kind: "error" | "success" | "info";
};
let items: Feedback[] = [];
const listeners = new Set<() => void>();
export const feedbackSnapshot = () => items;
export function subscribeFeedback(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function dismissFeedback(id: string) {
  if (!items.some((item) => item.id === id)) return;
  items = items.filter((item) => item.id !== id);
  listeners.forEach((listener) => listener());
}
export function showFeedback(item: Feedback) {
  if (!item.message.trim()) return;
  // Shared inline notices and notifySaved may report the same successful action.
  items = [
    ...items.filter(
      (old) =>
        old.id !== item.id &&
        !(old.message === item.message && old.kind === item.kind),
    ),
    item,
  ].slice(-3);
  listeners.forEach((listener) => listener());
}
