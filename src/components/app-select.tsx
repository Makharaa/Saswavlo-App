"use client";

import {
  Check,
  ChevronDown,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type AppSelectOption<T extends string | number = string> = {
  value: T;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export function AppSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  placeholder = "აირჩიე",
  startIcon,
  disabled = false,
  className = "",
  ariaLabel,
  compact = false,
}: {
  value: T | null | undefined;
  options: AppSelectOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  startIcon?: ReactNode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value]
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  function updatePosition() {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const gap = 7;
    const viewportPadding = 10;
    const preferredWidth = Math.max(rect.width, compact ? 180 : 220);
    const width = Math.min(
      preferredWidth,
      window.innerWidth - viewportPadding * 2
    );
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding
    );

    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const estimatedHeight = Math.min(330, Math.max(110, options.length * 54 + 12));
    const openAbove = spaceBelow < 170 && spaceAbove > spaceBelow;

    setPosition({
      top: openAbove
        ? Math.max(viewportPadding, rect.top - Math.min(estimatedHeight, spaceAbove) - gap)
        : rect.bottom + gap,
      left,
      width,
      maxHeight: Math.max(110, Math.min(330, openAbove ? spaceAbove - gap : spaceBelow - gap)),
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;

    setHighlighted(Math.max(0, selectedIndex));
    const frame = requestAnimationFrame(() => {
      optionRefs.current[Math.max(0, selectedIndex)]?.focus();
    });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    const onReposition = () => updatePosition();

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function choose(option: AppSelectOption<T>) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function move(direction: 1 | -1) {
    if (!options.length) return;
    let next = highlighted;

    for (let tries = 0; tries < options.length; tries += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }

    setHighlighted(next);
    optionRefs.current[next]?.focus();
  }

  const menu =
    open && position && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            id={`${id}-menu`}
            className="app-select-menu"
            role="listbox"
            aria-label={ariaLabel || label || placeholder}
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                const next = options.findIndex((option) => !option.disabled);
                if (next >= 0) {
                  setHighlighted(next);
                  optionRefs.current[next]?.focus();
                }
              } else if (event.key === "End") {
                event.preventDefault();
                const next = [...options].reverse().findIndex((option) => !option.disabled);
                if (next >= 0) {
                  const actual = options.length - 1 - next;
                  setHighlighted(actual);
                  optionRefs.current[actual]?.focus();
                }
              }
            }}
          >
            {options.map((option, index) => {
              const active = option.value === value;
              return (
                <button
                  key={String(option.value)}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={highlighted === index ? 0 : -1}
                  className={`app-select-option ${active ? "active" : ""}`}
                  disabled={option.disabled}
                  onFocus={() => setHighlighted(index)}
                  onClick={() => choose(option)}
                >
                  <span className="app-select-option-copy">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>

                  <span className="app-select-option-state">
                    {option.badge && <em>{option.badge}</em>}
                    {active && <Check size={15} />}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div
      ref={rootRef}
      className={`app-select ${compact ? "compact" : ""} ${open ? "open" : ""} ${disabled ? "disabled" : ""} ${className}`}
    >
      {label && <small className="app-select-label">{label}</small>}

      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
          }
        }}
      >
        {startIcon && <span className="app-select-icon">{startIcon}</span>}

        <span className="app-select-value">
          <strong>{selected?.label || placeholder}</strong>
          {!compact && selected?.description && (
            <small>{selected.description}</small>
          )}
        </span>

        <ChevronDown size={15} className="app-select-chevron" />
      </button>

      {menu}
    </div>
  );
}
