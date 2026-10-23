const toggle = document.querySelector('[data-nav-toggle]');
const nav = document.querySelector('[data-primary-nav]');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.dataset.open !== 'true';
    nav.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      nav.dataset.open = 'false';
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

const campaignParameterNames = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const campaignParameters = new URLSearchParams();
const currentParameters = new URLSearchParams(window.location.search);
campaignParameterNames.forEach((name) => {
  const value = currentParameters.get(name);
  if (value) campaignParameters.set(name, value.slice(0, 300));
});

const decorateCampaignLink = (link) => {
  if (!campaignParameters.size || !link.href) return;
  const url = new URL(link.href, window.location.origin);
  campaignParameters.forEach((value, name) => url.searchParams.set(name, value));
  link.href = url.toString();
};

// Preserve ad attribution without cookies or local storage. Campaign parameters
// travel only with the visitor's links and remain available to Bókun checkout.
document.querySelectorAll('a[href^="/"], a[data-booking-event]').forEach(decorateCampaignLink);
document.querySelectorAll('[data-booking-event][data-src]').forEach((button) => {
  if (!campaignParameters.size) return;
  const url = new URL(button.dataset.src);
  campaignParameters.forEach((value, name) => url.searchParams.set(name, value));
  button.dataset.src = url.toString();
});

document.querySelectorAll('[data-bokun-link]').forEach((link) => {
  const configured = document.documentElement.dataset.bokunUrl;
  const product = link.dataset.product;
  if (configured) {
    const url = new URL(configured);
    if (product) url.searchParams.set('product', product);
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noopener';
    decorateCampaignLink(link);
  }
});

window.dataLayer = window.dataLayer || [];
const consentBanner = document.querySelector('[data-consent-banner]');
const consentKey = 'folkpaths-consent-v1';
let tagsLoaded = false;
let analyticsConsentGranted = false;

const loadGoogleTags = () => {
  if (tagsLoaded) return;
  tagsLoaded = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-TGXT7KCT';
  document.head.append(script);
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
};

const applyConsent = (choice) => {
  const granted = choice === 'accepted';
  analyticsConsentGranted = granted;
  window.gtag?.('consent', 'update', {
    ad_storage: granted ? 'granted' : 'denied',
    analytics_storage: granted ? 'granted' : 'denied',
    ad_user_data: granted ? 'granted' : 'denied',
    ad_personalization: granted ? 'granted' : 'denied'
  });
  if (granted) loadGoogleTags();
  if (consentBanner) consentBanner.hidden = true;
};

let savedConsent = null;
try { savedConsent = window.localStorage.getItem(consentKey); } catch {}
if (savedConsent === 'accepted' || savedConsent === 'necessary') applyConsent(savedConsent);
else if (consentBanner) consentBanner.hidden = false;

const saveConsent = (choice) => {
  try { window.localStorage.setItem(consentKey, choice); } catch {}
  applyConsent(choice);
};
consentBanner?.querySelector('[data-consent-accept]')?.addEventListener('click', () => saveConsent('accepted'));
consentBanner?.querySelector('[data-consent-reject]')?.addEventListener('click', () => saveConsent('necessary'));
document.querySelectorAll('[data-consent-reset]').forEach((button) => button.addEventListener('click', () => {
  try { window.localStorage.removeItem(consentKey); } catch {}
  if (consentBanner) {
    consentBanner.hidden = false;
    consentBanner.querySelector('[data-consent-accept]')?.focus();
  }
}));

const trackEvent = (name, parameters = {}) => {
  if (!analyticsConsentGranted) return;
  window.dataLayer.push({ event: name, ...parameters });
};

document.addEventListener('click', (event) => {
  const bookingLink = event.target.closest('[data-booking-event]');
  if (bookingLink) {
    const parameters = {
      tour_id: bookingLink.dataset.product || 'all-tours',
      item_id: bookingLink.dataset.product || 'all-tours',
      item_name: bookingLink.dataset.productName || bookingLink.textContent.trim(),
      value: Number(bookingLink.dataset.price || 0),
      currency: bookingLink.dataset.currency || 'THB',
      link_url: bookingLink.href,
      page_path: window.location.pathname
    };
    trackEvent('book_now_click', parameters);
    if (bookingLink.hostname?.endsWith('bokun.io') || bookingLink.dataset.src?.includes('bokun.io')) {
      trackEvent('begin_checkout', {
        tour_id: parameters.tour_id,
        link_url: parameters.link_url,
        page_path: parameters.page_path,
        ecommerce: {
          currency: parameters.currency,
          value: parameters.value,
          items: [{ item_id: parameters.item_id, item_name: parameters.item_name, price: parameters.value, quantity: 1 }]
        }
      });
    }
  }

  const tourLink = event.target.closest('[data-tour-select]');
  if (tourLink) trackEvent('tour_select', {
    tour_id: tourLink.dataset.product || 'unknown',
    item_id: tourLink.dataset.product || 'unknown',
    link_url: tourLink.href,
    page_path: window.location.pathname
  });

  const whatsappLink = event.target.closest('a[href*="wa.me/"]');
  if (whatsappLink) {
    const parameters = {
      link_url: whatsappLink.href,
      link_text: whatsappLink.textContent.trim(),
      page_path: window.location.pathname
    };
    trackEvent('whatsapp_click', parameters);
    if (/private tour/i.test(whatsappLink.href) || window.location.pathname === '/private-tours/') {
      trackEvent('private_tour_contact', parameters);
    }
  }

  const contactLink = event.target.closest('a[href^="tel:"], a[href^="mailto:"]');
  if (contactLink) trackEvent(contactLink.href.startsWith('tel:') ? 'phone_click' : 'email_click', {
    link_url: contactLink.href,
    page_path: window.location.pathname
  });
});

document.querySelectorAll('[data-hero-carousel]').forEach((carousel) => {
  const slides = [...carousel.querySelectorAll('[data-hero-slide]')];
  const previous = carousel.querySelector('[data-hero-prev]');
  const next = carousel.querySelector('[data-hero-next]');
  const toggleAutoplay = carousel.querySelector('[data-hero-toggle]');
  const position = carousel.querySelector('[data-hero-position]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrowViewport = window.matchMedia('(max-width: 56rem)');
  let index = 0;
  let timer;
  let manuallyPaused = false;
  let interactionPaused = false;

  if (narrowViewport.matches) {
    manuallyPaused = true;
    toggleAutoplay.textContent = 'Play';
    toggleAutoplay.setAttribute('aria-pressed', 'true');
    toggleAutoplay.setAttribute('aria-label', 'Play automatic photo rotation');
  } else {
    slides.forEach((slide) => { slide.hidden = false; });
  }

  const show = (nextIndex) => {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index;
      slide.dataset.active = String(active);
      slide.setAttribute('aria-hidden', String(!active));
      if (narrowViewport.matches) slide.hidden = !active;
    });
    if (position) position.textContent = `${index + 1} / ${slides.length}`;
  };

  const stop = () => window.clearInterval(timer);
  const start = () => {
    stop();
    if (manuallyPaused || interactionPaused || reducedMotion.matches || document.hidden) return;
    timer = window.setInterval(() => show(index + 1), 5500);
  };

  previous?.addEventListener('click', () => { show(index - 1); start(); });
  next?.addEventListener('click', () => { show(index + 1); start(); });
  toggleAutoplay?.addEventListener('click', () => {
    manuallyPaused = !manuallyPaused;
    toggleAutoplay.textContent = manuallyPaused ? 'Play' : 'Pause';
    toggleAutoplay.setAttribute('aria-pressed', String(manuallyPaused));
    toggleAutoplay.setAttribute('aria-label', manuallyPaused ? 'Play automatic photo rotation' : 'Pause automatic photo rotation');
    start();
  });
  carousel.addEventListener('pointerenter', () => { interactionPaused = true; stop(); });
  carousel.addEventListener('pointerleave', () => { interactionPaused = false; start(); });
  carousel.addEventListener('focusin', () => { interactionPaused = true; stop(); });
  carousel.addEventListener('focusout', (event) => { if (!carousel.contains(event.relatedTarget)) { interactionPaused = false; start(); } });
  document.addEventListener('visibilitychange', start);
  reducedMotion.addEventListener?.('change', start);
  start();
});

document.querySelectorAll('[data-review-carousel]').forEach((carousel) => {
  const track = carousel.querySelector('[data-review-track]');
  const slides = [...carousel.querySelectorAll('[data-review-slide]')];
  const previous = carousel.querySelector('[data-review-prev]');
  const next = carousel.querySelector('[data-review-next]');
  const toggleAutoplay = carousel.querySelector('[data-review-toggle]');
  const position = carousel.querySelector('[data-review-position]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let timer;
  let manuallyPaused = false;

  const show = (nextIndex, behavior = 'smooth') => {
    index = (nextIndex + slides.length) % slides.length;
    track.scrollTo({ left: slides[index].offsetLeft - track.offsetLeft, behavior: reducedMotion.matches ? 'auto' : behavior });
    if (position) position.textContent = `${index + 1} / ${slides.length}`;
  };

  const stop = () => window.clearInterval(timer);
  const start = () => {
    stop();
    if (manuallyPaused || reducedMotion.matches || document.hidden) return;
    timer = window.setInterval(() => show(index + 1), 6000);
  };

  previous?.addEventListener('click', () => { show(index - 1); start(); });
  next?.addEventListener('click', () => { show(index + 1); start(); });
  toggleAutoplay?.addEventListener('click', () => {
    manuallyPaused = !manuallyPaused;
    toggleAutoplay.textContent = manuallyPaused ? 'Play' : 'Pause';
    toggleAutoplay.setAttribute('aria-pressed', String(manuallyPaused));
    toggleAutoplay.setAttribute('aria-label', manuallyPaused ? 'Play automatic review rotation' : 'Pause automatic review rotation');
    start();
  });
  track?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); start(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); start(); }
  });
  carousel.addEventListener('pointerenter', stop);
  carousel.addEventListener('pointerleave', start);
  carousel.addEventListener('focusin', stop);
  carousel.addEventListener('focusout', (event) => { if (!carousel.contains(event.relatedTarget)) start(); });
  document.addEventListener('visibilitychange', start);
  reducedMotion.addEventListener?.('change', start);
  start();
});

const communityReviews = document.querySelector('[data-published-reviews]');
if (communityReviews) {
  const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  fetch('/api/reviews', { headers: { Accept: 'application/json' } })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Reviews unavailable')))
    .then(({ reviews = [] }) => {
      if (!reviews.length) {
        communityReviews.innerHTML = '<p class="empty-reviews">No direct-booking reviews have been published yet.</p>';
        return;
      }
      communityReviews.innerHTML = reviews.map((review) => `<article class="community-review-card"><div class="review-source"><strong>Verified direct booking</strong><span aria-label="Rated ${review.rating} out of 5">${review.rating} / 5</span></div><blockquote><p>${escapeText(review.reviewText)}</p></blockquote><p class="review-meta">${escapeText(review.displayName)} · ${escapeText(review.tourName)} · ${escapeText(review.tourMonth)}</p></article>`).join('');
      const schema = {
        '@context': 'https://schema.org',
        '@graph': reviews.map((review) => ({
          '@type': 'Review',
          itemReviewed: { '@type': 'TouristTrip', name: review.tourName },
          author: { '@type': 'Person', name: review.displayName },
          datePublished: review.publishedAt,
          reviewBody: review.reviewText,
          reviewRating: { '@type': 'Rating', ratingValue: review.rating, bestRating: 5, worstRating: 1 }
        }))
      };
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify(schema).replaceAll('<', '\\u003c');
      document.head.append(script);
    })
    .catch(() => { communityReviews.innerHTML = '<p class="empty-reviews">Verified reviews cannot be loaded right now. Please try again later.</p>'; });
}

document.querySelectorAll('[data-review-form]').forEach((form) => {
  const verifyPanel = form.querySelector('[data-review-verify]');
  const composePanel = form.querySelector('[data-review-compose]');
  const status = form.querySelector('[data-review-status]');
  let verificationToken = '';
  let turnstileToken = '';
  const turnstileSiteKey = document.documentElement.dataset.turnstileSiteKey;
  const turnstileContainer = form.querySelector('[data-turnstile-container]');

  if (turnstileSiteKey && turnstileContainer) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => window.turnstile?.render(turnstileContainer, { sitekey: turnstileSiteKey, callback: (token) => { turnstileToken = token; }, 'expired-callback': () => { turnstileToken = ''; } }));
    document.head.append(script);
  }

  const setBusy = (busy) => {
    form.setAttribute('aria-busy', String(busy));
    form.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  };
  const showStatus = (message, isError = false) => {
    status.textContent = message;
    status.dataset.error = String(isError);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    setBusy(true);
    showStatus(form.dataset.step === 'verify' ? 'Checking your booking securely…' : 'Sending your review for moderation…');
    try {
      if (form.dataset.step === 'verify') {
        const response = await fetch('/api/reviews/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ bookingCode: form.elements.bookingCode.value, email: form.elements.email.value, turnstileToken })
        });
        const result = await response.json();
        if (!response.ok || !result.verificationToken) throw new Error(result.message || 'We could not verify those details. Check the complete code and booking email, then try again after the tour.');
        verificationToken = result.verificationToken;
        form.dataset.step = 'compose';
        verifyPanel.hidden = true;
        composePanel.hidden = false;
        showStatus(`Booking verified for ${result.tourName}. Your booking details will stay private.`);
        form.elements.displayName.focus();
      } else {
        const response = await fetch('/api/reviews', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            verificationToken,
            displayName: form.elements.displayName.value,
            rating: Number(form.elements.rating.value),
            reviewText: form.elements.reviewText.value,
            displayConsent: form.elements.displayConsent.checked
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'The review could not be submitted. Please try again.');
        composePanel.hidden = true;
        showStatus('Thank you. Your review was received and is awaiting moderation before publication.');
      }
    } catch (error) {
      showStatus(error.message || 'Something went wrong. Please try again.', true);
    } finally {
      setBusy(false);
    }
  });
});
