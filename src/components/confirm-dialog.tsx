"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "დადასტურება",
  cancelLabel = "გაუქმება",
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-head">
          <span><AlertTriangle size={18} /></span>
          <button type="button" onClick={onClose} disabled={busy} aria-label="დახურვა">
            <X size={17} />
          </button>
        </div>

        <div className="confirm-dialog-copy">
          <h3 id="confirm-dialog-title">{title}</h3>
          <p>{description}</p>
        </div>

        <div className="confirm-dialog-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "იშლება..." : confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
