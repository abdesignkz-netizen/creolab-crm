import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { dismissFeedback, showFeedback, type Feedback } from "./feedbackStore";

/** Keep context in the page while surfacing action results outside the scroll area. */
export function InlineFeedback({
  children,
  kind = "error",
  message: explicitMessage,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & {
  kind?: Feedback["kind"];
  message?: string;
}) {
  const id = useId(),
    element = useRef<HTMLParagraphElement>(null);
  const [inDialog, setInDialog] = useState(false);
  const message =
    explicitMessage ?? (typeof children === "string" ? children : "");
  useEffect(() => {
    const node = element.current;
    const dialog = node?.closest(
      'dialog[open], [role="dialog"][aria-modal="true"]',
    );
    setInDialog(Boolean(dialog));
    if (dialog && node) {
      // Native dialogs are above portals and make the rest of the document inert.
      const rect = node.getBoundingClientRect(),
        bounds = dialog.getBoundingClientRect();
      if (
        rect.top < Math.max(0, bounds.top) ||
        rect.bottom > Math.min(window.innerHeight, bounds.bottom)
      )
        node.scrollIntoView({ block: "nearest", behavior: "instant" });
    } else if (message) showFeedback({ id, message, kind });
    return () => dismissFeedback(id);
  }, [id, message, kind]);
  return (
    <p
      {...props}
      ref={element}
      role={inDialog ? (kind === "error" ? "alert" : "status") : undefined}
    >
      {children}
    </p>
  );
}
