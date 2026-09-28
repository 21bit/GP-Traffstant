/**
 * Shared geometry utilities — pure functions with no side-effects.
 * Centralising these avoids duplication across MapContainer, RouteEngine,
 * and SafetyOverlay.
 */

/** Haversine great-circle distance in kilometres. */
export const haversineDistanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Perpendicular distance from point P to segment A→B, in kilometres. */
export const distanceToSegmentKm = (pLat, pLng, aLat, aLng, bLat, bLng) => {
  const dLat = bLat - aLat;
  const dLng = bLng - aLng;
  const lenSq = dLat * dLat + dLng * dLng;
  if (lenSq === 0) return haversineDistanceKm(pLat, pLng, aLat, aLng);
  const t = Math.max(
    0,
    Math.min(1, ((pLat - aLat) * dLat + (pLng - aLng) * dLng) / lenSq)
  );
  return haversineDistanceKm(pLat, pLng, aLat + t * dLat, aLng + t * dLng);
};

/** Returns true if the incident falls within maxDistanceKm of any polyline segment. */
export const isIncidentNearPolyline = (routePoints, incident, maxDistanceKm) => {
  for (let i = 0; i < routePoints.length - 1; i++) {
    const [aLat, aLng] = routePoints[i];
    const [bLat, bLng] = routePoints[i + 1];
    if (
      distanceToSegmentKm(incident.lat, incident.lng, aLat, aLng, bLat, bLng) <=
      maxDistanceKm
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Shortest distance (in metres) from a point to a polyline.
 *
 * Iterates each [A, B] segment of the polyline and returns the minimum
 * perpendicular distance.  Used by the navigation off-route detector to
 * decide when to trigger a silent re-route.
 *
 * `polyline` is expected to be an array of `[lat, lng]` tuples.  Returns
 * `Infinity` if the polyline has fewer than two points so callers can
 * safely compare against any threshold without special-casing.
 */
export const distanceToPolylineMeters = (lat, lng, polyline) => {
  if (!Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let minKm = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const [aLat, aLng] = polyline[i];
    const [bLat, bLng] = polyline[i + 1];
    const segKm = distanceToSegmentKm(lat, lng, aLat, aLng, bLat, bLng);
    if (segKm < minKm) minKm = segKm;
  }
  return minKm * 1000;
};

/**
 * Projects a point `(lat, lng)` onto the closest location on a polyline.
 *
 * Returns a `{ snapped, distanceMeters, segmentIndex, segmentT }` record:
 *   • `snapped`         — [lat, lng] of the nearest location on the polyline.
 *   • `distanceMeters`  — perpendicular distance from the input to `snapped`.
 *   • `segmentIndex`    — index `i` such that the match lies on the segment
 *                         `polyline[i] → polyline[i+1]`.
 *   • `segmentT`        — scalar in `[0, 1]` indicating how far along that
 *                         segment the match fell (0 = start, 1 = end).
 *
 * Returns `null` when `polyline` is empty or malformed so callers can branch
 * safely without special-casing.
 *
 * Options:
 *   • `minSegmentIndex` — lower bound on the segment search range.  When
 *     provided, the projection considers only segments at or after this
 *     index, which makes the match MONOTONIC along the polyline.  This is
 *     critical for U-turns / hairpins where the route doubles back on
 *     itself: without ratcheting, the global-nearest projection can flip
 *     to the opposite leg of the U-turn (e.g. snap to the outbound lane
 *     while the driver is on the return leg), which freezes the route-
 *     trim slice and produces the "overlapping line at U-turn" artifact.
 *
 * Used by the navigation "Map Matching" layer to snap the raw GPS fix to the
 * active route line whenever the driver is within a realistic tolerance
 * (e.g. ≤ 30 m).  Keeps the chevron visually locked to the road instead of
 * floating on the shoulder due to multi-metre GNSS noise.
 */
export const projectPointOntoPolyline = (lat, lng, polyline, options = {}) => {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (polyline.length === 1) {
    return {
      snapped: [polyline[0][0], polyline[0][1]],
      distanceMeters:
        haversineDistanceKm(lat, lng, polyline[0][0], polyline[0][1]) * 1000,
      segmentIndex: 0,
      segmentT: 0,
    };
  }

  const rawMinIndex = Number.isInteger(options.minSegmentIndex)
    ? options.minSegmentIndex
    : 0;
  // Clamp to a valid segment index — the last legal segment starts at
  // polyline.length - 2 (its endpoint is the final vertex).  Clamping
  // both ends defensively means callers cannot accidentally exclude the
  // final segment by passing a too-large index after a route shrinks.
  const startIdx = Math.max(0, Math.min(rawMinIndex, polyline.length - 2));

  let bestDistanceKm = Infinity;
  let bestSnapped = [polyline[startIdx][0], polyline[startIdx][1]];
  let bestSegmentIndex = startIdx;
  let bestT = 0;

  for (let i = startIdx; i < polyline.length - 1; i++) {
    const [aLat, aLng] = polyline[i];
    const [bLat, bLng] = polyline[i + 1];
    const dLat = bLat - aLat;
    const dLng = bLng - aLng;
    const lenSq = dLat * dLat + dLng * dLng;

    let segT = 0;
    let snappedLat = aLat;
    let snappedLng = aLng;
    if (lenSq > 0) {
      segT = Math.max(
        0,
        Math.min(1, ((lat - aLat) * dLat + (lng - aLng) * dLng) / lenSq)
      );
      snappedLat = aLat + segT * dLat;
      snappedLng = aLng + segT * dLng;
    }

    const segDistKm = haversineDistanceKm(lat, lng, snappedLat, snappedLng);
    if (segDistKm < bestDistanceKm) {
      bestDistanceKm = segDistKm;
      bestSnapped = [snappedLat, snappedLng];
      bestSegmentIndex = i;
      bestT = segT;
    }
  }

  return {
    snapped: bestSnapped,
    distanceMeters: bestDistanceKm * 1000,
    segmentIndex: bestSegmentIndex,
    segmentT: bestT,
  };
};

/**
 * Snaps `(lat, lng)` to the active polyline if it falls within
 * `maxDistanceMeters`.  Returns the snapped `[lat, lng]` tuple when the
 * projection succeeds, or the original input tuple otherwise so callers
 * can assign the result unconditionally.
 *
 * The companion `projected` object (return of {@link projectPointOntoPolyline})
 * is also returned so callers can reuse the projection for downstream
 * calculations (e.g. remaining-distance-on-route) without re-projecting.
 *
 * `options.minSegmentIndex` is forwarded to {@link projectPointOntoPolyline}
 * so callers can ratchet the search window forward across consecutive GPS
 * fixes.  See that function's docstring for the U-turn rationale.
 */
export const snapPointToPolyline = (
  lat,
  lng,
  polyline,
  maxDistanceMeters,
  options
) => {
  const projected = projectPointOntoPolyline(lat, lng, polyline, options);
  if (!projected) {
    return { coords: [lat, lng], snapped: false, projection: null };
  }
  if (projected.distanceMeters <= maxDistanceMeters) {
    return { coords: projected.snapped, snapped: true, projection: projected };
  }
  return { coords: [lat, lng], snapped: false, projection: projected };
};

/**
 * Distance (in metres) still to travel along `polyline`, starting from the
 * projection of `(lat, lng)` onto the line and ending at the final vertex.
 *
 * Algorithm:
 *   1. Project the user onto the polyline (reusing `projectPointOntoPolyline`).
 *   2. Accumulate:
 *      • the leftover of the matched segment from the projection to its end, plus
 *      • the haversine length of every subsequent segment.
 *
 * Returns `0` for empty / single-point polylines so the ETA dashboard renders
 * a safe zero rather than NaN when the route briefly degenerates during a
 * silent reroute.
 */
export const remainingDistanceOnPolylineMeters = (lat, lng, polyline) => {
  const projected = projectPointOntoPolyline(lat, lng, polyline);
  if (!projected || !Array.isArray(polyline) || polyline.length < 2) return 0;

  const { snapped, segmentIndex } = projected;
  const [segEndLat, segEndLng] = polyline[segmentIndex + 1];

  let totalKm = haversineDistanceKm(snapped[0], snapped[1], segEndLat, segEndLng);
  for (let i = segmentIndex + 1; i < polyline.length - 1; i++) {
    const [aLat, aLng] = polyline[i];
    const [bLat, bLng] = polyline[i + 1];
    totalKm += haversineDistanceKm(aLat, aLng, bLat, bLng);
  }
  return totalKm * 1000;
};

/**
 * Returns a FORWARD-ONLY slice of `routePoints` starting at the driver's
 * snapped location, used to render the "Google-Maps-style" navigation
 * polyline where the portion of the route already driven is invisible.
 *
 * Parameters:
 *   • `routePoints`   — the full, original route `[[lat, lng], ...]`.
 *   • `segmentIndex`  — index `i` (from `projectPointOntoPolyline`) such
 *                       that the driver's projection lies on the segment
 *                       `routePoints[i] → routePoints[i + 1]`.
 *   • `snappedCoord`  — `[lat, lng]` of the driver's projection; becomes
 *                       the first vertex of the returned slice so the line
 *                       always starts EXACTLY at the chevron.
 *
 * The function is intentionally side-effect-free and does NOT mutate the
 * input.  The caller retains the original route for ETA / off-route /
 * reroute calculations; this slice is for rendering only.
 *
 * Defensive behaviour:
 *   • Falsy / < 2-vertex input → returned as-is so callers can render
 *     whatever they have without NPE.
 *   • `segmentIndex` is clamped into `[0, routePoints.length - 1]`.
 *   • If the driver is already on the final segment, the slice collapses
 *     to `[snappedCoord, lastVertex]` — the visual line naturally shrinks
 *     to a point as the driver reaches the destination.
 */
export const sliceRouteFromProgress = (routePoints, segmentIndex, snappedCoord) => {
  if (!Array.isArray(routePoints) || routePoints.length < 2) return routePoints;
  if (!Array.isArray(snappedCoord) || snappedCoord.length < 2) return routePoints;

  const safeIndex = Math.max(
    0,
    Math.min(Number.isInteger(segmentIndex) ? segmentIndex : 0, routePoints.length - 1)
  );
  return [snappedCoord, ...routePoints.slice(safeIndex + 1)];
};

/**
 * Great-circle bearing in degrees clockwise from true north, normalised to
 * the half-open range `[0, 360)`.
 *
 * Used as a heading fallback for the navigation chevron when
 * `GeolocationPosition.coords.heading` is null/NaN — which happens on
 * desktop browsers and a subset of iOS versions even during an active
 * `watchPosition` session.  Matches the CSS rotation convention where
 * `transform: rotate(Xdeg)` rotates clockwise with 0deg pointing up, so the
 * SVG must be drawn pointing up at the 12 o'clock position.
 */
export const computeBearingDegrees = (fromLat, fromLng, toLat, toLng) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  const phi1 = toRad(fromLat);
  const phi2 = toRad(toLat);
  const deltaLambda = toRad(toLng - fromLng);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
};
