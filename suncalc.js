// Minimal sun-times calculator (sunrise/sunset/civil twilight), vendored so the
// page has no CDN dependency. Same astronomical approach as SunCalc
// (https://github.com/mourner/suncalc, BSD-2-Clause, (c) Vladimir Agafonkin),
// reduced to the times this page needs. Accuracy is about a minute.
(function (global) {
  'use strict';
  var PI = Math.PI, rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009;
  var e = rad * 23.4397; // obliquity of the Earth

  function toDays(date) { return date.valueOf() / dayMs - 0.5 + J1970 - J2000; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
  function declination(l) { return Math.asin(Math.sin(l) * Math.sin(e)); }
  function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
  function eclipticLongitude(M) {
    var C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + rad * 102.9372 + PI;
  }
  function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * PI)); }
  function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * PI) + n; }
  function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L); }
  function hourAngle(h, phi, d) { return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d))); }

  // date: any instant on the wanted day (pass local noon for the local day).
  function getTimes(date, lat, lng) {
    var lw = rad * -lng, phi = rad * lat, d = toDays(date), n = julianCycle(d, lw),
      ds = approxTransit(0, lw, n), M = solarMeanAnomaly(ds), L = eclipticLongitude(M),
      dec = declination(L), Jnoon = solarTransitJ(ds, M, L);
    function pair(angle) {
      var w = hourAngle(angle * rad, phi, dec);
      if (isNaN(w)) return [null, null];
      var Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
    }
    var sun = pair(-0.833), civil = pair(-6);
    return { solarNoon: fromJulian(Jnoon), sunrise: sun[0], sunset: sun[1], civilDawn: civil[0], civilDusk: civil[1] };
  }

  global.SunTimes = { getTimes: getTimes };
})(typeof window !== 'undefined' ? window : globalThis);
