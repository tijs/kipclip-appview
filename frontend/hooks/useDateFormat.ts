/**
 * Hook that returns a date formatter bound to the user's preferred date format
 * from AppContext preferences.
 */

import { useCallback } from "react";
import { useApp } from "../context/AppContext.tsx";
import { type DateFormatOption, formatDate } from "../../shared/date-format.ts";

export function useDateFormat(): (isoDate: string) => string {
  const { preferences } = useApp();
  const format = preferences.dateFormat as DateFormatOption;

  return useCallback(
    (isoDate: string) => formatDate(isoDate, format),
    [format],
  );
}
