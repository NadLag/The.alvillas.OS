"use client";

import { Delete } from "lucide-react";

export function PinKeypad({ disabled, onDigit, onDelete, onClear, labels }: {
  disabled: boolean; onDigit: (digit: string) => void; onDelete: () => void; onClear: () => void;
  labels: { keypad: string; clear: string; delete: string };
}) {
  return <div className="pin-keypad" role="group" aria-label={labels.keypad} dir="ltr" data-testid="login-pin-keypad">
    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(digit => <button className="secondary-button" type="button" key={digit}
      disabled={disabled} onClick={() => onDigit(digit)} data-testid={`pin-key-${digit}`}>{digit}</button>)}
    <button className="secondary-button pin-keypad-action" type="button" disabled={disabled} onClick={onClear} data-testid="pin-key-clear">{labels.clear}</button>
    <button className="secondary-button" type="button" disabled={disabled} onClick={() => onDigit("0")} data-testid="pin-key-0">0</button>
    <button className="secondary-button" type="button" disabled={disabled} onClick={onDelete} data-testid="pin-key-delete" aria-label={labels.delete}><Delete aria-hidden="true" size={24} /></button>
  </div>;
}
