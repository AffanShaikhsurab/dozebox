// Timings the drills share with examples/drill/main.tf. Production defaults live in terraform/ and do not change.

/** `idle_minutes` of the drill stack (examples/drill/main.tf). The module's validation accepts nothing below 5. */
export const IDLE_MINUTES = 5;

/** `--with-hold`: how long the hold stays open; it must outlast the idle window, or it proves nothing. */
export const HOLD_MINUTES = IDLE_MINUTES + 1;

/** A box whose hold was released must park within this many minutes (one idle window and a minute of slack). */
export const PARK_WITHIN_MINUTES = IDLE_MINUTES + 1;
