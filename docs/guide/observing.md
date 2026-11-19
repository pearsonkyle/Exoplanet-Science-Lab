# Observing: time, cameras and live reduction

The **Run** page (`observe/run/`) runs an observing sequence from start to end. It:

- cools the camera;
- takes bias, dark and flat frames;
- waits for the window, the target's altitude and the dark;
- takes light frames until the window ends, the target sets or the Sun rises.

Every frame is written as FITS with a full header. Light frames are reduced as they arrive, and at the end the light curve goes to Analyze. The same sequence runs from Python with `esl.observe`.

From **Plan**, choose an event and press **Observe this event**. Run opens with that event's window, target and site.

## Time

A frame's time is only as good as the clock that stamped it. Every page that uses "now" (Plan, Observe, Run) corrects the computer's clock and shows how well it did: the clock badge reads, for example, `±12 ms · pearsonkyle.github.io Date header`.

| Source | Where it works | Typical bound | How |
|---|---|---|---|
| The site's own `Date` header | every page, including the published site | 10–50 ms | `HEAD` requests to this site, timed at second boundaries (`src/core/clocksync.js`) |
| timeapi.io | when the site gives no `Date` header | 10–50 ms | millisecond answers, CORS open |
| USB GPS (Web Serial) | Chrome, Edge; no internet needed | about ±125 ms | NMEA RMC/ZDA (`src/core/nmea.js`); without the PPS pulse the receiver's latency limits it |
| Local helper: NTP | the observing computer | 1–20 ms | SNTP to the NTP Pool (`esl.time`) |
| Local helper: gpsd with PPS | the observing computer | about 1 ms | gpsd's PPS reports |

**Why NTP needs the helper.** Browsers cannot send NTP: it uses UDP, which web pages can't open. The NTP Pool and time.jeffgeerling.com are therefore reached through the helper.

**Reading time.jeffgeerling.com.** Its status page (`/api/status`) sends no CORS headers, so a web page can't read it either. It is one person's GNSS-disciplined server and is used only if you ask: `python -m esl.time --geerling`, or `--time ntp,geerling` for the helper.

**NTP Pool rules.** `esl.time` follows them: at most four servers, one packet per server per call, no server asked twice within 64 s, and Kiss-o'-Death answers stop all queries to that server. If you ship this in software many people run, ask the NTP Pool for a vendor zone (<https://www.ntppool.org/vendors.html>) and set `ESL_NTP_SERVERS`.

**Time scales.** The readouts show Local, Site, UTC, JD (UTC), MJD, BJD_TDB of the target, and LST, which comes with the target's hour angle. One leap-second table (`src/core/timescale.js`) serves the whole code. `leapCheck` compares it with the leap-second count a GNSS receiver or server reports.

## The local helper

```bash
pip install "exoplanet-science-lab[camera]"
```

```bash
python -m esl.bridge --simulate
```

```bash
ZWO_ASI_LIB=/path/to/libASICamera2.dylib python -m esl.bridge --zwo --save-dir ~/ESL/frames
```

```bash
python -m esl.bridge --alpaca http://192.168.1.20:11111
```

The helper serves the camera as an **ASCOM Alpaca** device on `http://localhost:11111`. ASCOM Alpaca is the standard HTTP interface for astronomy equipment, so N.I.N.A., alpyca and other Alpaca clients can use the helper too. It also serves:

- `/esl/time`: the corrected clock and its bound.
- `/esl/exposure`: when the last exposure started, by that clock.
- `/esl/save`: writes the frames the page makes into `--save-dir`.

**Reaching it from the published site.** No hosting is involved: the published site reaches the helper because browsers let https pages call `http://localhost`. Chrome asks once whether the site may use the local network. Safari blocks it; use Chrome or Edge.

**What it allows.** The helper listens on 127.0.0.1 only. It answers web pages only from the published site and from pages served from localhost; add others with `--allow-origin`. Requests without an Origin header, such as N.I.N.A. or scripts, are always answered.

**ZWO cameras.** These use ZWO's ASI SDK through `zwoasi`. Download the SDK from ZWO and point `ZWO_ASI_LIB` at the library. On Linux, also install ZWO's udev rules.

**Pass-through.** `--alpaca URL` passes another Alpaca camera through, for example ASCOM Remote in front of a Windows ASCOM driver.

## Headers

`src/core/fitsheader.js` writes the cards:

- **Time:** DATE-OBS / DATE-AVG / DATE-END (UTC, milliseconds), MJD-OBS / MJD-AVG / MJD-END, JD_UTC and BJD_TDB at mid-exposure, LST and HA.
- **Clock:** CLKSRC, CLKOFFS (the correction applied) and CLKUNC (the bound).
- **Site:** SITELAT / SITELONG / SITEELEV and OBSGEO-B/L/H.
- **Target:** RA / DEC, OBJCTRA / OBJCTDEC, OBJCTALT / OBJCTAZ, AIRMASS, MOONSEP.
- **Camera:** GAIN, OFFSET, EGAIN, binning, pixel size, temperatures, Bayer pattern, PIERSIDE.
- **WCS:** a TAN WCS, either from the plate solution or from the pointing, pixel scale and camera angle (then WCSAPPRX = T).
- **Provenance:** SWCREATE, SEQID, FRAMENO, HISTORY.

The browser (`encodeFits`) and Python (`esl.observe.fits_bytes`) write byte-identical files. The Photometry page reads them back.

## Trying it without hardware

Choose **Simulated** as the camera.

**Try now** runs a short test window starting now.

**Rehearse its next transit** picks a real planet from the catalogue snapshot (HAT-P-32 b, WASP-12 b, HD 189733 b and others). It finds that planet's next transit that is observable whole from the site and runs it on a clock 10–120 times faster than real time. The simulated camera renders the planet's own transit (the core transit model, quadratic limb darkening) at the true BJD_TDB and airmass.

**Show the predicted transit** draws that model, the prior, over the live light curve.

**Simulated tracking** adds the errors of a real mount:
- a slow wander;
- the worm gear's periodic error;
- fast jitter that blurs the stars;
- jumps.

The **telemetry** strips show what the reduction measured for every frame:
- where the target sits on the sensor;
- FWHM, sky and airmass;
- the comparison stars' total flux (transparency);
- the sensor temperature;
- the clock's uncertainty.

For the simulator, the true pointing is drawn as orange dashes.

## What has not been checked

- No real camera has been run. The ZWO backend was tested against a fake SDK that mimics `zwoasi`'s calls. The first run on a real ASI camera is yours: frame times, ImageBytes speed and the cooler go into the Validation notes.
- Plate solving the first frame, mount control (pointing, meridian flips) and filter wheels are not done yet. The meridian pause asks you to flip by hand.
- Python's `esl.observe` takes and writes the frames but does not reduce them live. Reduce the folder with the Photometry page.
- On a rehearsal clock, the page's own processing time also runs faster, about 9 virtual seconds per frame at 60×. A rehearsal therefore takes about 10% fewer frames than the plan.
