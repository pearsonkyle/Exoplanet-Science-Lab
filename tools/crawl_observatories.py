#!/usr/bin/env python
"""Look for public data archives, all-sky cameras and weather monitors of the observatories in
public/observatories/sites.json, and record what answers today in public/observatories/resources.json.

What it does, per observatory
  1 starts from a short curated seed list (SEEDS, NET_SEEDS below): the observatory's home page and pages believed
    to be its archive, its all-sky camera or its weather page. The seeds are guesses until a request confirms them.
  2 fetches each seed once, and on that page only (depth 1, never further) looks for links whose text or address
    says archive / all-sky / weather, on the same site; each such link is fetched once to confirm it answers.
  3 on a page classified as an all-sky camera, looks for the image itself and asks for it the way a browser on
    another site would (with a Referer header), recording the headers that decide whether it may be shown inline.
  Only resources that answered HTTP 200 on the day are written. Nothing is presented that was not fetched.

Manners
  - robots.txt of every host is read first and obeyed for this User-Agent (a host whose robots.txt cannot be read
    with a server error is skipped; a missing robots.txt means allowed, as the standard says)
  - one request at a time per host with DELAY seconds between them; a handful of hosts in parallel
  - GET only, no forms, no logins, no query strings invented here, no cookies kept, redirects followed at most 5 times
  - at most MAX_BYTES of any page are read, 2 kB of an image; timeouts of 10 s to connect and 20 s to read
  - a descriptive User-Agent that names the project and carries no personal contact details

Inline display. The Plan page shows an all-sky image inline only when ALL of these hold, and links out otherwise:
  headers   the image is https, answers 200 with an image content type to a request carrying another site's Referer,
            and sends no Cross-Origin-Resource-Policy of same-origin or same-site
  fresh     its Last-Modified is less than 48 h old (a camera that stopped years ago must not be shown as live)
  robots    robots.txt allows the image path
  terms     the host's published terms were fetched today and contain an open licence (TERMS below: the terms page
            and the phrase looked for). A host whose terms were not reviewed is never embedded.
For pages, X-Frame-Options and Content-Security-Policy frame-ancestors are recorded (`frame`), but the Plan page
does not put anybody's page in a frame.

Usage: python tools/crawl_observatories.py [--out public/observatories] [--only id,id] [--delay 2]
Needs requests.
"""
import argparse, datetime, email.utils, json, os, re, sys, threading, time, urllib.parse, urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser

import requests

UA = 'ExoplanetScienceLab-ObservatoryResources/1.0 (+https://exoplanet.science/plan/; looks once for public archive, all-sky camera and weather links of observatories)'
REFERER = 'https://exoplanet.science/plan/'
DELAY, MAX_BYTES, TIMEOUT = 2.0, 400_000, (10, 20)
MAX_FOUND = 2            # discovered links kept per kind and observatory
FRESH_H = 48

# kind: 'home' (only searched for links), 'archive', 'allsky', 'weather', 'allsky-image' (the image itself)
SEEDS = {
    'keck': [('home', 'https://www.maunakeaobservatories.org/'), ('weather', 'http://mkwc.ifa.hawaii.edu/'), ('weather', 'https://www.cfht.hawaii.edu/en/gallery/cloudcams/'),
             ('archive', 'https://koa.ipac.caltech.edu/'), ('archive', 'https://smoka.nao.ac.jp/'), ('archive', 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/cfht/'),
             ('archive', 'https://archive.gemini.edu/'), ('allsky', 'https://www.cfht.hawaii.edu/en/gallery/cloudcams/'), ('allsky', 'https://www.gemini.edu/observing/telescopes-and-sites/sites'),
             ('allsky', 'http://mkwc.ifa.hawaii.edu/current/cams/')],
    'mpcf65': [('home', 'https://about.ifa.hawaii.edu/facility/haleakala-observatories/'), ('weather', 'http://kopiko.ifa.hawaii.edu/weather/'), ('archive', 'https://panstarrs.stsci.edu/')],
    'lick': [('home', 'https://www.lickobservatory.org/'), ('home', 'https://mthamilton.ucolick.org/'), ('weather', 'https://mthamilton.ucolick.org/hamcam/'), ('allsky', 'https://mthamilton.ucolick.org/hamcam/skycam/'),
             ('archive', 'https://mthamilton.ucolick.org/data/')],
    'mwo': [('home', 'https://www.mtwilson.edu/'), ('weather', 'https://www.mtwilson.edu/weather/'), ('allsky', 'http://www.astro.ucla.edu/~obs/towercam.htm')],
    'mpc673': [('home', 'https://tmf.jpl.nasa.gov/')],
    'palomar': [('home', 'https://sites.astro.caltech.edu/palomar/'), ('weather', 'https://sites.astro.caltech.edu/palomar/observer/weather.html'), ('allsky', 'https://sites.astro.caltech.edu/palomar/allsky/'),
                ('archive', 'https://irsa.ipac.caltech.edu/Missions/ztf.html'), ('archive', 'https://www.ptf.caltech.edu/')],
    'mlo': [('home', 'https://mintaka.sdsu.edu/'), ('home', 'https://astronomy.sdsu.edu/mount-laguna-observatory/')],
    'mpcu69': [('home', 'https://www.sierra-remote.com/'), ('weather', 'https://www.sierra-remote.com/weather')],
    'kpno': [('home', 'https://kpno.noirlab.edu/'), ('weather', 'https://noirlab.edu/science/observing-noirlab/weather-webcams/kitt-peak'), ('allsky', 'https://kpasca.kpno.noirlab.edu/'),
             ('allsky', 'https://noirlab.edu/science/observing-noirlab/weather-webcams/kitt-peak/all-sky-camera'), ('weather', 'https://www-kpno.kpno.noirlab.edu/Info/Mtn_Weather/')],
    'flwo': [('home', 'https://www.mmto.org/'), ('weather', 'https://www.mmto.org/weather/'), ('allsky', 'https://skycam.mmto.arizona.edu/'), ('archive', 'https://lweb.cfa.harvard.edu/MEarth/Data.html'),
             ('home', 'https://pweb.cfa.harvard.edu/facilities-technology/cfa-facilities/fred-lawrence-whipple-observatory-mt-hopkins-az')],
    'lowell': [('home', 'https://lowell.edu/'), ('weather', 'https://www2.lowell.edu/users/massey/weather.html')],
    'dct': [('home', 'https://lowell.edu/research/telescopes-and-facilities/ldt/'), ('weather', 'https://www2.lowell.edu/weather/')],
    'mtbigelow': [('home', 'https://www.as.arizona.edu/kuiper-61-telescope'), ('allsky', 'http://skycenter.arizona.edu/allsky')],
    'mpcg84': [('home', 'https://skycenter.arizona.edu/'), ('weather', 'https://skycenter.arizona.edu/weather'), ('allsky', 'https://skycenter.arizona.edu/allsky')],
    'lbt': [('home', 'https://www.lbto.org/'), ('weather', 'https://www.lbto.org/weather.html'), ('archive', 'http://archive.lbto.org/'), ('allsky', 'https://www.lbto.org/allsky.html')],
    'winer': [('home', 'http://www.winer.org/'), ('weather', 'http://www.winer.org/Site/Weather.php')],
    'mpcg95': [('home', 'http://www.brucegary.net/HAO/')],
    'mpcu94': [('home', 'https://www.utahdesertremoteobservatories.com/')],
    'apo': [('home', 'https://www.apo.nmsu.edu/'), ('weather', 'https://www.apo.nmsu.edu/weather/'), ('allsky', 'https://irsc.apo.nmsu.edu/'), ('allsky', 'https://www.apo.nmsu.edu/Telescopes/ARC35m/webcams.html'),
            ('archive', 'https://www.sdss.org/dr18/'), ('archive', 'https://data.sdss.org/')],
    'mpch06': [('home', 'https://www.nmskies.com/'), ('weather', 'https://www.nmskies.com/weather.html')],
    'mpch01': [('home', 'https://www.mro.nmt.edu/'), ('weather', 'https://www.mro.nmt.edu/weather/')],
    'mcdonald': [('home', 'https://mcdonaldobservatory.org/'), ('weather', 'https://weather.as.utexas.edu/'), ('allsky', 'https://weather.as.utexas.edu/latest_5min_allsky.html'), ('allsky', 'https://monetn.as.utexas.edu/')],
    'mpc802': [('home', 'https://mo-www.cfa.harvard.edu/MicroObservatory/'), ('home', 'https://pweb.cfa.harvard.edu/facilities-technology/telescopes-instruments/microobservatory-0')],
    'mpcw38': [('home', 'https://dso.appstate.edu/'), ('weather', 'https://dso.appstate.edu/weather')],
    'dao': [('home', 'https://centreoftheuniverse.org/'), ('archive', 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/dao/'), ('weather', 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/dao/weather/')],
    'mpc661': [('home', 'https://science.ucalgary.ca/rothney-observatory'), ('weather', 'https://www.ucalgary.ca/rao/weather')],
    'omm': [('home', 'https://omm-astro.ca/'), ('weather', 'https://omm-astro.ca/en/meteo/')],
    'spm': [('home', 'https://www.astrossp.unam.mx/'), ('weather', 'https://www.astrossp.unam.mx/weather15/'), ('allsky', 'https://www.astrossp.unam.mx/indexspm.html')],
    'ctio': [('home', 'https://noirlab.edu/science/programs/ctio'), ('weather', 'https://noirlab.edu/science/observing-noirlab/weather-webcams/cerro-tololo'),
             ('allsky', 'https://noirlab.edu/science/observing-noirlab/weather-webcams/cerro-tololo/all-sky-cameras'), ('weather', 'http://www.ctio.noao.edu/noao/content/Weather-and-Seeing'),
             ('weather', 'https://www.ctio.noirlab.edu/site-conditions/')],
    'gemini_south': [('home', 'https://www.gemini.edu/'), ('weather', 'https://noirlab.edu/science/observing-noirlab/weather-webcams/cerro-pachon'), ('archive', 'https://archive.gemini.edu/'),
                     ('allsky', 'https://www.gemini.edu/observing/telescopes-and-sites/sites')],
    'lasilla': [('home', 'https://www.eso.org/sci/facilities/lasilla.html'), ('weather', 'https://www.eso.org/asm/ui/publicLog?name=LaSilla'), ('weather', 'https://www.ls.eso.org/lasilla/dimm/'),
                ('allsky', 'https://www.ls.eso.org/lasilla/dimm/lasc/'), ('weather', 'https://www.eso.org/sci/facilities/lasilla/astclim/weather.html'), ('home', 'https://www.trappist.uliege.be/')],
    'lco': [('home', 'https://www.lco.cl/'), ('weather', 'https://weather.lco.cl/'), ('allsky', 'https://weather.lco.cl/clima/weather/allsky.html'), ('weather', 'https://www.lco.cl/weather/')],
    'paranal': [('home', 'https://www.eso.org/sci/facilities/paranal.html'), ('weather', 'https://www.eso.org/asm/ui/publicLog?name=Paranal'), ('weather', 'https://www.eso.org/sci/facilities/paranal/astroclimate/site.html'),
                ('allsky', 'https://www.eso.org/public/outreach/webcams/'), ('archive', 'https://archive.eso.org/wdb/wdb/asm/meteo_paranal/form'), ('archive', 'https://ngtransits.org/data.html'),
                ('home', 'https://www.speculoos.uliege.be/')],
    'oca': [('home', 'https://www.astro.ruhr-uni-bochum.de/astro/oca/'), ('home', 'https://araucaria.camk.edu.pl/index.php/observatory-cerro-armazones/')],
    'mpcx07': [('home', 'https://www.deepskychile.com/')],
    'mpcx02': [('home', 'https://www.obstech.cl/'), ('weather', 'https://www.obstech.cl/weather/')],
    'mpcg39': [('home', 'https://www.spaceobs.com/'), ('weather', 'https://www.spaceobs.com/en/Weather')],
    'mpc829': [('home', 'https://casleo.conicet.gov.ar/'), ('weather', 'https://casleo.conicet.gov.ar/clima/')],
    'mpc821': [('home', 'https://oac.unc.edu.ar/')],
    'mpc874': [('home', 'https://www.gov.br/lna/pt-br'), ('weather', 'https://lnapadrao.lna.br/OPD/meteorologia')],
    'lapalma': [('home', 'https://www.ing.iac.es/'), ('weather', 'https://www.ing.iac.es/ds/weather/'), ('allsky', 'https://www.gtc.iac.es/multimedia/webcams.php'), ('weather', 'https://www.not.iac.es/weather/'),
                ('allsky', 'https://www.not.iac.es/weather/skycam.html'), ('archive', 'http://casu.ast.cam.ac.uk/casuadc/ingarch/query'), ('archive', 'https://gtc.sdc.cab.inta-csic.es/gtc/'),
                ('archive', 'https://telescope.livjm.ac.uk/cgi-bin/lt_search'), ('weather', 'https://telescope.livjm.ac.uk/Reports/Status/'), ('allsky', 'https://telescope.livjm.ac.uk/TelInst/Skycam/'),
                ('weather', 'https://tngweb.tng.iac.es/weather/'), ('archive', 'http://archives.ia2.inaf.it/tng/')],
    'teide': [('home', 'https://www.iac.es/en/observatorios-de-canarias/teide-observatory'), ('weather', 'https://www.iac.es/en/observatorios-de-canarias/teide-observatory/weather'),
              ('allsky', 'https://www.iac.es/en/observatorios-de-canarias/teide-observatory/webcams'), ('weather', 'https://www.telescope.org/weather.php')],
    'mpcz53': [('home', 'https://www.trappist.uliege.be/'), ('home', 'http://www.oukaimeden.org/')],
    'caha': [('home', 'https://www.caha.es/'), ('weather', 'https://www.caha.es/WDXI/wdxi.php'), ('allsky', 'https://www.caha.es/allsky/'), ('archive', 'https://caha.sdc.cab.inta-csic.es/calto/'),
             ('weather', 'https://www.caha.es/observing-mainmenu-161/weather-monitor-mainmenu-164')],
    'mpcj86': [('home', 'https://www.osn.iaa.csic.es/'), ('weather', 'https://www.osn.iaa.csic.es/page/meteorologia'), ('weather', 'https://www.osn.iaa.csic.es/meteo/')],
    'oaj': [('home', 'https://oajweb.cefca.es/'), ('weather', 'https://oajweb.cefca.es/observatory/weather'), ('archive', 'https://archive.cefca.es/catalogues/'), ('allsky', 'https://oajweb.cefca.es/observatory/webcams')],
    'mpcc65': [('home', 'https://montsec.ieec.cat/en/'), ('weather', 'https://montsec.ieec.cat/en/observatory/meteo/'), ('allsky', 'https://montsec.ieec.cat/en/observatory/allsky/')],
    'mpci89': [('home', 'https://www.astrocamp.es/'), ('weather', 'https://www.astrocamp.es/en/weather/')],
    'mpc586': [('home', 'https://www.obs-mip.fr/pic-du-midi/'), ('home', 'https://picdumidi.com/en'), ('allsky', 'https://picdumidi.com/en/webcams')],
    'ohp': [('home', 'http://www.obs-hp.fr/'), ('weather', 'http://www.obs-hp.fr/meteo/meteo.shtml'), ('archive', 'http://atlas.obs-hp.fr/'), ('allsky', 'http://www.obs-hp.fr/meteo/allsky.shtml')],
    'mpcr87': [('home', 'https://www.oca.eu/en/')],
    'ekar': [('home', 'https://www.oapd.inaf.it/sede-di-asiago'), ('weather', 'https://www.oapd.inaf.it/sede-di-asiago/telescopes-and-instrumentations/meteo'), ('archive', 'https://www.ia2.inaf.it/'),
             ('allsky', 'https://www.oapd.inaf.it/sede-di-asiago/telescopes-and-instrumentations/webcam')],
    'mpc598': [('home', 'https://www.oas.inaf.it/en/loiano/'), ('weather', 'http://davide2.bo.astro.it/loiano/meteo/')],
    'wendelstein': [('home', 'https://www.wendelstein-observatorium.de/'), ('weather', 'https://www.wendelstein-observatorium.de/wetter/'), ('allsky', 'https://www.wendelstein-observatorium.de/webcams/')],
    'mpc033': [('home', 'https://www.tls-tautenburg.de/'), ('weather', 'https://www.tls-tautenburg.de/TLS/index.php?id=31')],
    'mpc557': [('home', 'https://www.asu.cas.cz/en'), ('weather', 'https://www.asu.cas.cz/en/about/weather'), ('allsky', 'https://www.asu.cas.cz/~meteor/bolid/allsky/')],
    'mpc056': [('home', 'https://www.astro.sk/'), ('allsky', 'https://www.astro.sk/l3.php?p3=sp'), ('weather', 'https://www.astro.sk/weather/')],
    'mpc461': [('home', 'https://konkoly.hu/en'), ('weather', 'https://ccdsh.konkoly.hu/wiki/Weather'), ('allsky', 'https://www.konkoly.hu/staff/racz/allsky.html')],
    'mpc152': [('home', 'https://mao.tfai.vu.lt/')],
    'mpc071': [('home', 'https://nao-rozhen.org/'), ('weather', 'https://nao-rozhen.org/weather/'), ('allsky', 'https://nao-rozhen.org/allsky/')],
    'mpcl10': [('home', 'https://kryoneri.astro.noa.gr/en/'), ('weather', 'https://kryoneri.astro.noa.gr/en/weather/')],
    'tug': [('home', 'https://tug.tubitak.gov.tr/en'), ('weather', 'https://tug.tubitak.gov.tr/en/teleskoplar/weather'), ('allsky', 'https://tug.tubitak.gov.tr/en/allsky')],
    'mpc095': [('home', 'https://crao.ru/en/')],
    'mpc115': [('home', 'https://www.sao.ru/'), ('weather', 'https://www.sao.ru/tb/tcs/meteo/'), ('archive', 'https://www.sao.ru/oasis/cgi-bin/fetch?lang=en'), ('allsky', 'https://www.sao.ru/hq/sekbta/allsky/')],
    'mpcb18': [('home', 'http://www.terskol.com/')],
    'mpc168': [('home', 'https://astro.insma.urfu.ru/en')],
    'wise': [('home', 'https://wise-obs.tau.ac.il/'), ('weather', 'https://wise-obs.tau.ac.il/weather/'), ('allsky', 'https://wise-obs.tau.ac.il/allsky/')],
    'mpcm40': [('home', 'https://www.nriag.sci.eg/')],
    'salt': [('home', 'https://www.saao.ac.za/'), ('weather', 'https://suthweather.saao.ac.za/'), ('allsky', 'https://www.saao.ac.za/astronomers/all-sky-camera/'), ('archive', 'https://ssda.saao.ac.za/'),
             ('weather', 'https://www.salt.ac.za/~saltmet/weather.txt'), ('home', 'https://astronomers.salt.ac.za/')],
    'mpc074': [('home', 'https://www.ufs.ac.za/natagri/departments-and-divisions/physics-home/boyden-observatory')],
    'mpcl87': [('home', 'https://www.hakos-astrofarm.com/'), ('weather', 'https://www.hakos-astrofarm.com/wetter/')],
    'mpc188': [('home', 'http://www.maidanak.uz/')],
    'iao': [('home', 'https://www.iiap.res.in/centers/iao/'), ('weather', 'https://www.iiap.res.in/centers/iao/weather/')],
    'dot': [('home', 'https://www.aries.res.in/facilities/astronomical-telescopes/36m-telescope'), ('weather', 'https://www.aries.res.in/weather')],
    'vbo': [('home', 'https://www.iiap.res.in/centers/vbo/')],
    'mpcn87': [('home', 'http://english.xao.cas.cn/')],
    'lijiang': [('home', 'http://www.gmg.org.cn/'), ('weather', 'http://weather.gmg.org.cn:9000/')],
    'bao': [('home', 'http://www.xinglong-naoc.cn/'), ('weather', 'http://www.xinglong-naoc.cn/weather/')],
    'tno': [('home', 'https://www.narit.or.th/'), ('weather', 'https://weather.narit.or.th/'), ('allsky', 'https://www.narit.or.th/index.php/allsky')],
    'mpcd35': [('home', 'https://www.lulin.ncu.edu.tw/english/'), ('weather', 'https://www.lulin.ncu.edu.tw/weather/'), ('allsky', 'https://www.lulin.ncu.edu.tw/allsky/'), ('allsky', 'https://www.lulin.ncu.edu.tw/weather/cur_weather.htm')],
    'mpc344': [('home', 'https://boao.kasi.re.kr/'), ('weather', 'https://boao.kasi.re.kr/weather/')],
    'oao': [('home', 'https://www.oao.nao.ac.jp/en/'), ('weather', 'https://www.oao.nao.ac.jp/weather/'), ('archive', 'https://smoka.nao.ac.jp/'), ('allsky', 'https://www.oao.nao.ac.jp/skymonitor/')],
    'mpc381': [('home', 'http://www.ioa.s.u-tokyo.ac.jp/kisohp/top_e.html'), ('allsky', 'http://www.ioa.s.u-tokyo.ac.jp/kisohp/WEATHER/weather_e.html'), ('archive', 'https://smoka.nao.ac.jp/')],
    'mpcd20': [('home', 'https://www.uwa.edu.au/facilities/zadko-observatory')],
    'sso': [('home', 'https://rsaa.anu.edu.au/observatories/siding-spring-observatory'), ('weather', 'https://www.aao.gov.au/weather'), ('allsky', 'https://www.aao.gov.au/weather/allsky'),
            ('archive', 'https://datacentral.org.au/'), ('archive', 'https://skymapper.anu.edu.au/'), ('allsky', 'https://www.mso.anu.edu.au/~rsmith/sso_allsky/'), ('weather', 'https://aat-ops.anu.edu.au/met/metgraph.html')],
    'mpce22': [('home', 'https://www.unisq.edu.au/research/institutes-centres/centre-for-astrophysics/mount-kent-observatory')],
    'mso': [('home', 'https://rsaa.anu.edu.au/observatories/mount-stromlo-observatory')],
    'mpcq54': [('home', 'https://www.utas.edu.au/natural-sciences/physics/greenhill-observatory')],
    'otehiwai_observatory': [('home', 'https://www.canterbury.ac.nz/study/academic-study/science/facilities/mt-john-observatory'), ('weather', 'https://www.canterbury.ac.nz/weather/mt-john')],
}
# shared by every observatory that belongs to a network (sites.json `nets`)
NET_SEEDS = {
    'LCO': [('archive', 'https://archive.lco.global/'), ('weather', 'https://weather.lco.global/'), ('home', 'https://lco.global/observatory/sites/')],
    'ESO': [('archive', 'https://archive.eso.org/cms.html'), ('archive', 'https://archive.eso.org/scienceportal/home')],
    'NOIRLab': [('archive', 'https://astroarchive.noirlab.edu/'), ('home', 'https://noirlab.edu/science/observing-noirlab/weather-webcams')],
    'MicroObservatory': [('archive', 'https://mo-www.cfa.harvard.edu/MicroObservatory/'), ('archive', 'https://mo-www.cfa.harvard.edu/cgi-bin/ImageDirectory/ImageDirectory.cgi')],
    'iTelescope': [('home', 'https://www.itelescope.net/'), ('weather', 'https://www.itelescope.net/weather')],
    'TRAPPIST': [('home', 'https://www.trappist.uliege.be/')],
    'SPECULOOS': [('home', 'https://www.speculoos.uliege.be/')],
    'NGTS': [('archive', 'https://ngtransits.org/data.html')],
    'KELT': [('archive', 'https://exoplanetarchive.ipac.caltech.edu/docs/KELT.html')],
    'MEarth': [('archive', 'https://lweb.cfa.harvard.edu/MEarth/Data.html')],
    'SAINT-EX': [('home', 'https://www.saintex.unibe.ch/')],
    'MINERVA': [], 'MINERVA-Australis': [],
}
# published terms that allow reuse, by host suffix: (terms page, phrase that must be on it today, licence label)
TERMS = {
    'eso.org': ('https://www.eso.org/public/copyright/', r'Creative\s+Commons\s+Attribution\s+4\.0', 'CC BY 4.0 (ESO)'),
    'noirlab.edu': ('https://noirlab.edu/public/copyright/', r'Creative\s+Commons\s+Attribution\s+4\.0', 'CC BY 4.0 (NOIRLab/NSF/AURA)'),
}

# link text that names a kind (checked in this order), and words that must be somewhere on a page of that kind
KEY = {
    'allsky': re.compile(r'(all[\s-]?sky|sky[\s-]?cam|cloud[\s-]?cam|sky\s+monitor|\bweb\s?cams?\b)', re.I),
    'weather': re.compile(r'(\bweather|\bmeteo\b|\bmeteorolog|\bseeing\b|site\s+conditions|environmental\s+monitor|astro-?climat)', re.I),
    'archive': re.compile(r'(data\s+archive|science\s+archive|archive\s+search|public\s+archive|data\s+access\b|data\s+releases?\b|\barchiv[eo]s?\b)', re.I),
}
BODY = {
    'allsky': re.compile(r'(all[\s-]?sky|sky[\s-]?cam|cloud[\s-]?cam|web\s?cam|camera)', re.I),
    'weather': re.compile(r'(weather|meteo|humidity|wind|seeing|temperature)', re.I),
    'archive': re.compile(r'(archive|data\s+release|download|query)', re.I),
}
NOT_TEXT = re.compile(r'(protocol|policy|polic|proposal|\btac\b|\blogs?\b|^\W*archiv[eo]s?\W*$|news|press|histor|meteor(?!olog)|fireball|job|newsletter|image\s+archive|photo|gallery|publication|forecast\s+model|privacy)', re.I)
NOT_URL = re.compile(r'(news|press|announce|blog|event)', re.I)
# several observatories share one web site (noirlab.edu, eso.org, iac.es ...): a link found there that names ANOTHER of them is not ours
SLUGS = {'kpno': ['kitt', 'kpno'], 'ctio': ['tololo', 'ctio'], 'gemini_south': ['pachon', 'gemini'], 'lasilla': ['silla'], 'paranal': ['paranal'], 'keck': ['mauna', 'keck'],
         'lapalma': ['palma', 'roque', 'orm'], 'teide': ['teide', 'tenerife', 'izana'], 'sso': ['siding'], 'mso': ['stromlo'], 'iao': ['iao', 'hanle'], 'vbo': ['vbo', 'kavalur'],
         'lowell': ['anderson'], 'dct': ['ldt', 'discovery'], 'mtbigelow': ['bigelow', 'kuiper'], 'mpcg84': ['lemmon']}
IMG_HINT = re.compile(r'(all.?sky|sky.?cam|cloud.?cam|asca|asc[_-]|latest|current|last|live|skymon|webcam)', re.I)
NOT_PAGE = re.compile(r'\.(pdf|zip|gz|tar|fits?|mp4|mov|docx?|pptx?|xlsx?)($|\?)', re.I)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.a, self.img, self.title, self._href, self._text, self._in_title, self.forms_pw = [], [], '', None, [], False, False

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == 'a' and d.get('href'):
            self._href, self._text = d['href'], [d.get('title') or '']
        elif tag == 'img' and d.get('src'):
            self.img.append((d['src'], d.get('alt') or ''))
            if self._href is not None:
                self._text.append(d.get('alt') or '')
        elif tag == 'title':
            self._in_title = True
        elif tag == 'input' and (d.get('type') or '').lower() == 'password':
            self.forms_pw = True

    def handle_endtag(self, tag):
        if tag == 'a' and self._href is not None:
            self.a.append((self._href, ' '.join(' '.join(self._text).split())[:120]))
            self._href = None
        elif tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)
        if self._in_title:
            self.title += data


def site_of(host):
    """Registrable part of a host name, roughly: the last two labels, or three for second-level country domains."""
    p = host.lower().split('.')
    if len(p) >= 3 and (len(p[-1]) == 2 and p[-2] in ('ac', 'co', 'edu', 'gov', 'org', 'com', 'res', 'or', 'nao', 'sci', 'conicet', 'unc', 'ncu') or p[-2:] == ['gov', 'br']):
        return '.'.join(p[-3:])
    return '.'.join(p[-2:])


class Crawler:
    def __init__(self, delay):
        self.delay, self.cache, self.robots, self.locks, self.last = delay, {}, {}, {}, {}
        self.guard, self.nreq, self.blocked, self.why = threading.Lock(), 0, 0, {}
        self.s = requests.Session()
        self.s.headers.update({'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5', 'Accept-Language': 'en'})
        self.s.max_redirects = 5

    def _lock(self, host):
        with self.guard:
            return self.locks.setdefault(host, threading.Lock())

    def _wait(self, host):
        dt = self.delay - (time.time() - self.last.get(host, 0))
        if dt > 0:
            time.sleep(dt)

    def allowed(self, url):
        u = urllib.parse.urlsplit(url)
        base = f'{u.scheme}://{u.netloc}'
        with self._lock(u.netloc):
            if base not in self.robots:
                rp = urllib.robotparser.RobotFileParser()
                for attempt in (1, 2):                              # one retry, after a pause, when the connection fails
                    self._wait(u.netloc)
                    try:
                        r = self.s.get(base + '/robots.txt', timeout=TIMEOUT, stream=True)
                        body = r.raw.read(200_000, decode_content=True).decode('utf-8', 'replace') if r.status_code == 200 else ''
                        r.close()
                        self.nreq += 1
                        if r.status_code >= 500:
                            rp = None                               # cannot tell: stay away
                        elif r.status_code == 200 and '<html' not in body[:500].lower():
                            rp.parse(body.splitlines())
                        else:
                            rp.parse([])                            # no robots.txt: everything is allowed
                        break
                    except Exception as e:                          # DNS, TLS, timeout, reset
                        rp = 'unreachable'
                        self.why[base] = type(e).__name__
                        self.last[u.netloc] = time.time() + (6 if attempt == 1 else 0)
                self.last[u.netloc] = time.time()
                self.robots[base] = rp
            rp = self.robots[base]
        if rp is None or rp == 'unreachable':
            return False
        return rp.can_fetch(UA, url)

    def fetch(self, url, image=False):
        """One GET (cached). Returns dict(url, final, status, ctype, headers, text|None, error)."""
        key = (url, image)
        with self.guard:
            if key in self.cache:
                return self.cache[key]
        out = dict(url=url, final=url, status=0, ctype='', headers={}, text=None, error='')
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.netloc:
            out['error'] = 'not http'
        elif not self.allowed(url):
            base = f'{u.scheme}://{u.netloc}'
            out['error'] = 'robots.txt' if self.robots.get(base) not in (None, 'unreachable') else 'host unreachable' + (f' ({self.why[base]})' if base in self.why else ' (robots.txt gave a server error)')
            if out['error'] == 'robots.txt':
                self.blocked += 1
        else:
            with self._lock(u.netloc):
                for attempt in (1, 2):
                    self._wait(u.netloc)
                    try:
                        r = self.s.get(url, timeout=TIMEOUT, stream=True, headers={'Referer': REFERER} if image else {})
                        self.nreq += 1
                        out.update(status=r.status_code, final=r.url, ctype=(r.headers.get('content-type') or '').split(';')[0].strip().lower(), headers={k.lower(): v for k, v in r.headers.items()}, error='')
                        if r.status_code == 200:
                            raw = r.raw.read(2048 if image else MAX_BYTES, decode_content=True)
                            if not image and out['ctype'] in ('text/html', 'application/xhtml+xml', ''):
                                out['text'] = raw.decode(r.encoding or 'utf-8', 'replace')
                            out['nbytes'] = len(raw)
                        r.close()
                        break
                    except Exception as e:
                        out['error'] = type(e).__name__
                        self.last[u.netloc] = time.time() + (6 if attempt == 1 else 0)
                self.last[u.netloc] = time.time()
        with self.guard:
            self.cache[key] = out
        return out


def frame_policy(h):
    xfo = (h.get('x-frame-options') or '').strip().upper()
    csp = h.get('content-security-policy') or ''
    m = re.search(r'frame-ancestors\s+([^;]+)', csp, re.I)
    fa = m.group(1).strip() if m else ''
    ok = not xfo and (not fa or fa == '*')
    return dict(xfo=xfo or None, frameAncestors=fa or None, allowed=ok)


def image_policy(r, now):
    h = r['headers']
    corp = (h.get('cross-origin-resource-policy') or '').strip().lower()
    lm = h.get('last-modified')
    age = None
    if lm:
        try:
            age = round((now - email.utils.parsedate_to_datetime(lm)).total_seconds() / 3600, 1)
        except (TypeError, ValueError):
            age = None
    https = r['final'].startswith('https://')
    is_img = r['status'] == 200 and r['ctype'].startswith('image/')
    headers_ok = https and is_img and corp not in ('same-origin', 'same-site')
    return dict(url=r['final'], status=r['status'], type=r['ctype'], https=https, cors=h.get('access-control-allow-origin'), corp=corp or None,
                lastModified=lm, ageHours=age, headersAllow=headers_ok, fresh=age is not None and age <= FRESH_H)


def crawl_site(C, site, now, today, terms_ok):
    seeds = list(SEEDS.get(site['id'], []))
    for n in site.get('nets', []):
        seeds += [('net' if k == 'home' else k + '*', u) for k, u in NET_SEEDS.get(n, [])]   # a network's pages are shared by all its nodes: used, not searched for links
    res = {'archive': [], 'allsky': [], 'weather': []}
    tried, seen = [], set()
    home_site = {site_of(urllib.parse.urlsplit(u).netloc) for _, u in seeds}

    others = [w for sid, ws in SLUGS.items() if sid != site['id'] for w in ws if w not in SLUGS.get(site['id'], [])]
    labels = set()

    def entry(kind, r, how, label, src=None):
        final = r['final']
        if final in seen or (kind, label.lower()) in labels:
            return None
        if not BODY[kind].search(r['text'] or ''):                 # a page that never mentions its subject is not it (a redirect to a home page, say)
            return None
        seen.add(final)
        labels.add((kind, label.lower()))
        e = dict(url=final, label=label, how=how, status=r['status'], checked=today, frame=frame_policy(r['headers']))
        if src:
            e['foundOn'] = src
        if final != r['url']:
            e['asked'] = r['url']
        res[kind].append(e)
        return e

    def look_for_image(e, page):
        P = Links()
        try:
            P.feed(page['text'] or '')
        except Exception:
            return
        cands = []
        for src, alt in P.img:
            full = urllib.parse.urljoin(page['final'], src)
            if IMG_HINT.search(src + ' ' + alt) and not re.search(r'(logo|icon|banner|sprite|thumb)', src, re.I) and full not in cands:
                cands.append(full)
        for full in cands[:3]:
            r = C.fetch(full, image=True)
            if r['status'] == 200 and r['ctype'].startswith('image/'):
                e['image'] = image_policy(r, now)
                host = urllib.parse.urlsplit(r['final']).netloc
                t = next((v for k, v in terms_ok.items() if host == k or host.endswith('.' + k)), None)
                e['image']['terms'] = t or None
                e['image']['embed'] = bool(e['image']['headersAllow'] and e['image']['fresh'] and t)
                return

    pages = []
    for kind, url in seeds:
        if kind == 'allsky-image':
            continue
        shared = kind.endswith('*')
        kind = kind.rstrip('*')
        r = C.fetch(url)
        ok = r['status'] == 200 and (r['text'] is not None)
        tried.append(dict(url=url, kind=kind, status=r['status'], error=r['error'] or None))
        if not ok or kind == 'net':
            continue
        P = Links()
        try:
            P.feed(r['text'])
        except Exception:
            pass
        if P.forms_pw and kind != 'home':
            tried[-1]['error'] = 'login form'                       # nothing behind a login is offered
            continue
        title = ' '.join(P.title.split())[:90]
        if not title or re.search(r'redirect|^www\.|^index of', title, re.I):
            title = ''
        if not shared:
            pages.append((kind, r, P))
        if kind != 'home':
            if urllib.parse.urlsplit(r['final']).path.rstrip('/') != urllib.parse.urlsplit(url).path.rstrip('/') and not KEY[kind].search(title + ' ' + r['final']):
                tried[-1]['error'] = 'redirected elsewhere'
                continue
            e = entry(kind, r, 'seed', title or urllib.parse.urlsplit(r['final']).netloc)
            if e and kind == 'allsky':
                look_for_image(e, r)
    # depth 1: links on the fetched pages that name one of the three kinds, on the same site
    for kind0, r, P in pages:
        for href, text in P.a:
            full = urllib.parse.urldefrag(urllib.parse.urljoin(r['final'], href))[0]
            u = urllib.parse.urlsplit(full)
            if u.scheme not in ('http', 'https') or site_of(u.netloc) not in home_site or NOT_PAGE.search(u.path) or u.query or full == r['final']:
                continue
            if NOT_TEXT.search(text) or NOT_URL.search(u.path) or any(w in (full + ' ' + text).lower() for w in others):
                continue
            if u.path in ('', '/') and (u.netloc.startswith('www.') or u.netloc == urllib.parse.urlsplit(r['final']).netloc):
                continue                                            # a front page (this site's, or another site of the same institution) is not a resource
            for kind, rx in KEY.items():
                if len([e for e in res[kind] if e['how'] == 'found']) >= MAX_FOUND or full in seen:
                    continue
                if not rx.search(text):
                    continue
                rr = C.fetch(full)
                tried.append(dict(url=full, kind=kind, status=rr['status'], error=rr['error'] or None, found=True))
                if rr['status'] != 200 or rr['text'] is None or urllib.parse.urlsplit(rr['final']).path in ('', '/'):
                    continue                                        # not there, or redirected to a front page
                PP = Links()
                try:
                    PP.feed(rr['text'])
                except Exception:
                    pass
                if PP.forms_pw:
                    continue
                e = entry(kind, rr, 'found', text or ' '.join(PP.title.split())[:90], src=r['final'])
                if e and kind == 'allsky':
                    look_for_image(e, rr)
                break
    return site['id'], res, tried


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, '..', 'public', 'observatories'))
    ap.add_argument('--only', help='comma-separated site ids: crawl only these and merge them into the existing resources.json')
    ap.add_argument('--delay', type=float, default=DELAY)
    ap.add_argument('--log', help='write every request tried (also the failures) to this JSON file')
    a = ap.parse_args()
    sites = json.load(open(os.path.join(a.out, 'sites.json'), encoding='utf-8'))['sites']
    if a.only:
        sites = [s for s in sites if s['id'] in a.only.split(',')]
    missing = [s['id'] for s in sites if s['id'] not in SEEDS]
    if missing:
        print('no seeds for:', ', '.join(missing))
    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.strftime('%Y-%m-%d')
    C = Crawler(a.delay)

    # terms pages first: an open licence must be on the page today
    terms_ok, terms = {}, {}
    for host, (url, phrase, label) in TERMS.items():
        r = C.fetch(url)
        ok = r['status'] == 200 and bool(r['text']) and bool(re.search(phrase, r['text']))
        terms[host] = dict(url=url, licence=label, status=r['status'], phraseFound=ok, checked=today)
        if ok:
            terms_ok[host] = dict(url=url, licence=label)
        print(f'terms {host}: HTTP {r["status"]}, licence phrase {"found" if ok else "NOT found"}')

    out, log = {}, {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sid, res, tried in ex.map(lambda s: crawl_site(C, s, now, today, terms_ok), sites):
            log[sid] = tried
            if any(res.values()):
                out[sid] = {k: v for k, v in res.items() if v}
            n = {k: len(v) for k, v in res.items()}
            print(f'{sid:22s} archive {n["archive"]} allsky {n["allsky"]} weather {n["weather"]}   ({sum(1 for t in tried if t["status"] == 200)}/{len(tried)} requests answered 200)')

    path = os.path.join(a.out, 'resources.json')
    if a.only and os.path.exists(path):                             # merge a partial run into what is there
        old = json.load(open(path, encoding='utf-8'))
        merged = {k: v for k, v in old['sites'].items() if k not in {s['id'] for s in sites}}
        merged.update(out)
        all_sites = json.load(open(os.path.join(a.out, 'sites.json'), encoding='utf-8'))['sites']
        out, nsites = {s['id']: merged[s['id']] for s in all_sites if s['id'] in merged}, len(all_sites)
        terms = {**old.get('terms', {}), **terms}
        prev = old.get('summary', {})
    else:
        nsites, prev = len(sites), {}
    has = lambda k: sum(1 for r in out.values() if r.get(k))
    imgs = [(sid, e) for sid, r in out.items() for e in r.get('allsky', []) if e.get('image')]
    summary = dict(observatories=nsites, withAny=len(out), archive=has('archive'), allsky=has('allsky'), weather=has('weather'),
                   links=sum(len(v) for r in out.values() for v in r.values()),
                   allskyImages=len(imgs), imagesHeadersAllow=sum(1 for _, e in imgs if e['image']['headersAllow']),
                   imagesFresh=sum(1 for _, e in imgs if e['image']['headersAllow'] and e['image']['fresh']),
                   imagesEmbedded=sum(1 for _, e in imgs if e['image']['embed']), embeddedAt=sorted({sid for sid, e in imgs if e['image']['embed']}),
                   pagesFrameAllowed=sum(1 for r in out.values() for v in r.values() for e in v if e['frame']['allowed']),
                   requests=C.nreq + prev.get('requests', 0), refusedByRobots=C.blocked + prev.get('refusedByRobots', 0), seconds=round(time.time() - t0) + prev.get('seconds', 0))
    doc = dict(v=1, date=today, userAgent=UA, about='Public archive, all-sky camera and weather links of the observatories in sites.json that answered HTTP 200 on `date`. Built by tools/crawl_observatories.py: see its header for the method and the rule for inline images.',
               embedRule=f'an all-sky image is shown inline only if https, 200 with an image type to a cross-site request, no restrictive Cross-Origin-Resource-Policy, Last-Modified under {FRESH_H} h, allowed by robots.txt, and the host has reviewed open terms (terms)',
               terms=terms, summary=summary, sites=out)
    os.makedirs(a.out, exist_ok=True)
    open(path, 'w', encoding='utf-8').write(json.dumps(doc, ensure_ascii=False, indent=1))
    if a.log:
        open(a.log, 'w', encoding='utf-8').write(json.dumps(log, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
