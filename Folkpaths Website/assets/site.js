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

document.querySelectorAll('[data-bokun-link]').forEach((link) => {
  const configured = document.documentElement.dataset.bokunUrl;
  const product = link.dataset.product;
  if (configured) {
    const url = new URL(configured);
    if (product) url.searchParams.set('product', product);
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noopener';
  }
});

window.dataLayer = window.dataLayer || [];
const trackEvent = (name, parameters = {}) => {
  if (typeof window.gtag === 'function') window.gtag('event', name, parameters);
};

document.addEventListener('click', (event) => {
  const bookingLink = event.target.closest('[data-booking-event]');
  if (bookingLink) {
    const parameters = {
      tour_id: bookingLink.dataset.product || 'all-tours',
      link_url: bookingLink.href,
      page_path: window.location.pathname
    };
    trackEvent('book_now_click', parameters);
    if (bookingLink.hostname?.endsWith('bokun.io') || bookingLink.dataset.src?.includes('bokun.io')) {
      trackEvent('checkout_start', parameters);
    }
  }

  const tourLink = event.target.closest('[data-tour-select]');
  if (tourLink) trackEvent('tour_select', {
    tour_id: tourLink.dataset.product || 'unknown',
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
  const narrowViewport = window.matchMedia('(max-width: 56rem)');
  let manuallyPaused = narrowViewport.matches;

  if (manuallyPaused && toggleAutoplay) {
    toggleAutoplay.textContent = 'Play';
    toggleAutoplay.setAttribute('aria-pressed', 'true');
    toggleAutoplay.setAttribute('aria-label', 'Play automatic review rotation');
  }

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
