import { useEffect, useState } from "react";

type ToastProps = {
  message: string;
  variant?: "error" | "success";
  onDismiss: () => void;
  durationMs?: number | null;
};

export function Toast({
  message,
  variant = "error",
  onDismiss,
  durationMs,
}: ToastProps) {
  const [leaving, setLeaving] = useState(false);

  const duration =
    durationMs !== undefined
      ? durationMs
      : variant === "success"
      ? 3200
      : null;

  useEffect(() => {
    if (!duration) return;
    const t = window.setTimeout(() => {
      setLeaving(true);
      window.setTimeout(onDismiss, 180);
    }, duration);
    return () => clearTimeout(t);
  }, [duration, onDismiss]);

  const dismiss = () => {
    setLeaving(true);
    window.setTimeout(onDismiss, 180);
  };

  return (
    <div
      className={`tbox-toast tbox-toast--${variant}${leaving ? " is-leaving" : ""}`}
      role={variant === "error" ? "alert" : "status"}
    >
      <span className="tbox-toast__icon">
        {variant === "success" ? "✓" : "⚠"}
      </span>
      <span className="tbox-toast__msg">{message}</span>
      <button className="tbox-toast__dismiss" onClick={dismiss} aria-label="닫기">
        ✕
      </button>
    </div>
  );
}
