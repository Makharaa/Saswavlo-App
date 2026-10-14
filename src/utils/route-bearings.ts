/**
 * OSRM route bearings for ordered route anchors. At a junction, constraining
 * the outgoing bearing prevents OSRM from choosing the other branch merely
 * because it is marginally faster.
 */
export function routeWaypointBearings(waypoints: [number, number][]) {
  const bearing = (from: [number, number], to: [number, number]) => {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const toDeg = (value: number) => (value * 180) / Math.PI;
    const [lng1, lat1] = from.map(toRad);
    const [lng2, lat2] = to.map(toRad);
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  return waypoints.map((point, index) => {
    const next = waypoints[index + 1];
    const previous = waypoints[index - 1];
    const direction = next
      ? bearing(point, next)
      : previous
        ? bearing(previous, point)
        : 0;

    if (!previous || !next) return `${Math.round(direction)},45`;

    const incoming = bearing(previous, point);
    const turnAngle = Math.abs(((direction - incoming + 540) % 360) - 180);
    // A little more tolerance accommodates curved approach roads while still
    // distinguishing the opposite branch of a typical junction.
    const tolerance = turnAngle > 45 ? 60 : 45;
    return `${Math.round(direction)},${tolerance}`;
  }).join(";");
}
