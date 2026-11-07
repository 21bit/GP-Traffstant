import React, { useEffect, useId, useRef, useState } from "react";
import { useLanguage } from "../../LanguageContext";

/**
 * Accessible place search with keyboard nav, empty state, and recent locations.
 */
export default function PlaceSearchField({
  label,
  query,
  onQueryChange,
  placeholder,
  selectedLabel,
  suggestions,
  searching = false,
  noResults = false,
  recentLocations = [],
  onPick,
  trailing = null,
  listId,
}) {
  const { t } = useLanguage();
  const reactId = useId();
  const boxId = listId || `place-list-${reactId}`;
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focused, setFocused] = useState(false);

  const showRecent =
    focused &&
    !query.trim() &&
    recentLocations.length > 0 &&
    suggestions.length === 0 &&
    !noResults;

  const items = showRecent ? recentLocations : suggestions;
  const mode = showRecent ? "recent" : "suggestions";
  const showList = open && items.length > 0;
  const showEmpty = open && noResults && query.trim().length >= 2 && !searching;

  useEffect(() => {
    setActiveIndex(-1);
  }, [query, suggestions, showRecent]);

  const pick = (place) => {
    onPick(place);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    const listOpen = showList || showEmpty;
    if (!listOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      if (items.length > 0) setOpen(true);
      return;
    }

    if (!showList) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => (prev + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
    } else if (e.key === "Enter" && activeIndex >= 0 && items[activeIndex]) {
      e.preventDefault();
      pick(items[activeIndex]);
    }
  };

  const activeId =
    activeIndex >= 0 && items[activeIndex]
      ? `${boxId}-opt-${activeIndex}`
      : undefined;

  return (
    <label className="planner-field">
      {label}
      <div className="planner-input-row">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => {
            // Delay so option click can register
            setTimeout(() => {
              setFocused(false);
              setOpen(false);
              setActiveIndex(-1);
            }, 150);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={showList || showEmpty}
          aria-controls={boxId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
        />
        {trailing}
      </div>

      {showEmpty && (
        <div className="planner-no-results" id={boxId} role="status">
          لا توجد نتائج
        </div>
      )}

      {showList && (
        <ul
          className="planner-suggestions"
          id={boxId}
          role="listbox"
          aria-label={mode === "recent" ? t("recentLocations") : label}
        >
          {mode === "recent" && (
            <li className="planner-suggestions-caption" role="presentation">
              {t("recentLocations")}
            </li>
          )}
          {items.map((place, idx) => {
            const active = idx === activeIndex;
            return (
              <li key={`${place.lat}-${place.lng}-${idx}`} role="presentation">
                <button
                  type="button"
                  id={`${boxId}-opt-${idx}`}
                  role="option"
                  aria-selected={active}
                  className={active ? "active" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(place)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  {place.name}
                  {place.neighborhood ? ` · ${place.neighborhood}` : ""}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedLabel && !query && (
        <div className="planner-selected">{selectedLabel}</div>
      )}
    </label>
  );
}
