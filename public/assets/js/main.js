/* The Social Club
   Interactions (menu, accordion, carousel, contact form) work everywhere.
   Motion (Lenis smooth scroll, GSAP ScrollTrigger) only runs when the visitor
   has not asked for reduced motion. */
(() => {
  'use strict';

  const root = document.documentElement;
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  const { gsap, ScrollTrigger, Lenis } = window;
  const motionLibs = Boolean(gsap && ScrollTrigger);
  if (motionLibs) {
    window.__tscMotionReady = true;
    gsap.registerPlugin(ScrollTrigger);
  } else {
    root.classList.remove('motion');
  }

  let lenis = null;
  let motionOn = false;

  /* Footer year, always current */
  $$('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

  /* Scrolling helpers */
  function scrollToTarget(target, immediate = false) {
    if (lenis) {
      lenis.scrollTo(target, { offset: 0, immediate, duration: 1.4 });
      return;
    }
    const behavior = immediate || reducedQuery.matches ? 'auto' : 'smooth';
    if (typeof target === 'number') window.scrollTo({ top: target, behavior });
    else target.scrollIntoView({ behavior, block: 'start' });
  }

  function focusTarget(el) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }

  /* Header: solid when scrolled, tucks away on scroll down */
  const header = $('[data-header]');
  let lastY = window.scrollY;
  let ticking = false;
  function updateHeader() {
    const y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 8);
    const menuIsOpen = root.classList.contains('is-menu-open');
    const focusInHeader = header.contains(document.activeElement);
    if (!menuIsOpen && !focusInHeader) {
      if (y > lastY + 4 && y > 520) header.classList.add('is-hidden');
      else if (y < lastY - 4 || y <= 520) header.classList.remove('is-hidden');
    }
    lastY = y;
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { window.requestAnimationFrame(updateHeader); ticking = true; }
  }, { passive: true });
  header.addEventListener('focusin', () => header.classList.remove('is-hidden'));
  updateHeader();

  /* Current section in the primary nav */
  const navLinks = $$('.nav a[href^="#"]');
  if ('IntersectionObserver' in window && navLinks.length) {
    const byId = new Map(navLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const link = byId.get(entry.target.id);
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach((a) => a.removeAttribute('aria-current'));
          link.setAttribute('aria-current', 'true');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    byId.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  /* Mobile menu */
  const toggle = $('[data-menu-toggle]');
  const menu = $('[data-menu]');
  const menuLabel = $('[data-menu-label]');
  const outside = [$('#main'), $('.site-footer'), $('.skip-link')].filter(Boolean);
  let menuOpen = false;

  function setOutsideInert(on) {
    outside.forEach((el) => { el.inert = on; });
  }

  function openMenu() {
    if (menuOpen) return;
    menuOpen = true;
    menu.hidden = false;
    root.classList.add('is-menu-open');
    header.classList.remove('is-hidden');
    toggle.setAttribute('aria-expanded', 'true');
    menuLabel.textContent = 'Close';
    setOutsideInert(true);
    if (lenis) lenis.stop();
    document.body.style.overflow = 'hidden';
    if (motionOn) {
      gsap.killTweensOf([menu, '[data-menu-link]', '[data-menu-foot]']);
      gsap.fromTo(menu, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.9, ease: 'expo.inOut' });
      gsap.fromTo('[data-menu-link]', { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1, stagger: 0.05, delay: 0.3, ease: 'expo.out' });
      gsap.fromTo('[data-menu-foot]', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8, delay: 0.6, ease: 'expo.out' });
    }
  }

  function closeMenu(restoreFocus = true) {
    if (!menuOpen) return;
    menuOpen = false;
    toggle.setAttribute('aria-expanded', 'false');
    menuLabel.textContent = 'Menu';
    setOutsideInert(false);
    document.body.style.overflow = '';
    if (lenis) lenis.start();
    const finish = () => {
      menu.hidden = true;
      root.classList.remove('is-menu-open');
    };
    if (motionOn) {
      gsap.killTweensOf([menu, '[data-menu-link]', '[data-menu-foot]']);
      gsap.to(menu, { clipPath: 'inset(0% 0% 100% 0%)', duration: 0.7, ease: 'expo.inOut', onComplete: finish });
    } else {
      finish();
    }
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) closeMenu();
  });
  header.addEventListener('keydown', (e) => {
    if (!menuOpen || e.key !== 'Tab') return;
    const focusables = $$('a[href], button:not([disabled])', header).filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  window.matchMedia('(min-width: 1180px)').addEventListener('change', (e) => {
    if (e.matches) closeMenu(false);
  });

  /* In page links: smooth scroll, move focus, preselect a club */
  const programSelect = $('#f-program');
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute('href');
    const onHome = window.location.pathname === '/' || window.location.pathname === '/index.html';

    if (href === '/' && onHome) {
      e.preventDefault();
      closeMenu(false);
      scrollToTarget(0);
      window.history.pushState(null, '', '/');
      focusTarget($('#main'));
      return;
    }
    if (!href.startsWith('#') || href.length < 2) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    e.preventDefault();
    closeMenu(false);
    if (a.dataset.clubLink && programSelect) {
      const match = Array.from(programSelect.options).find((o) => o.value === a.dataset.clubLink);
      if (match) programSelect.value = match.value;
    }
    scrollToTarget(target);
    window.history.pushState(null, '', href);
    focusTarget(target);
  });

  /* FAQ accordion */
  let refreshTimer;
  $$('[data-acc]').forEach((acc) => {
    const btn = $('.acc__btn', acc);
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      acc.classList.toggle('is-open', !open);
      if (motionOn) {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => ScrollTrigger.refresh(), 650);
      }
    });
  });

  /* Testimonials carousel (native horizontal scroll with snap) */
  const carousel = $('[data-carousel]');
  if (carousel) {
    const prev = $('[data-carousel-prev]');
    const next = $('[data-carousel-next]');
    const quotes = $$('[data-quote]', carousel);
    const stepSize = () => {
      if (quotes.length < 2) return carousel.clientWidth;
      return quotes[1].getBoundingClientRect().left - quotes[0].getBoundingClientRect().left;
    };
    const setState = (btn, disabled) => {
      btn.setAttribute('aria-disabled', String(disabled));
      btn.classList.toggle('is-disabled', disabled);
    };
    const update = () => {
      const max = carousel.scrollWidth - carousel.clientWidth - 4;
      setState(prev, carousel.scrollLeft <= 4);
      setState(next, carousel.scrollLeft >= max);
    };
    const go = (dir, btn) => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      carousel.scrollBy({ left: dir * stepSize(), behavior: reducedQuery.matches ? 'auto' : 'smooth' });
    };
    prev.addEventListener('click', () => go(-1, prev));
    next.addEventListener('click', () => go(1, next));
    let raf;
    carousel.addEventListener('scroll', () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* Contact form */
  const form = $('[data-contact-form]');
  if (form) {
    const status = $('[data-form-status]', form);
    const errorBox = $('[data-form-errors]', form);
    const success = $('[data-form-success]');
    const submit = $('[data-submit]', form);
    const submitLabel = $('[data-submit-label]', form);
    const turnstileSlot = $('[data-turnstile]', form);
    const timeField = $('[data-form-time]', form);
    timeField.value = String(Date.now());

    const labels = { name: 'Your name', email: 'Email', phone: 'Phone', age: "Child's age", message: 'Message' };
    const rules = {
      name: (v) => (!v ? 'Please enter your name.' : v.length > 100 ? 'Please keep your name under 100 characters.' : ''),
      email: (v) => (!v ? 'Please enter your email address.'
        : (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) ? 'Please enter a valid email address, like name@example.com.' : ''),
      phone: (v) => (v && (!/^[0-9+().\s\-xX]{7,40}$/.test(v) || (v.match(/\d/g) || []).length < 7)
        ? 'Please enter a valid phone number, or leave this field blank.' : ''),
      age: (v) => (v.length > 20 ? 'Please keep this under 20 characters.' : ''),
      message: (v) => (!v ? 'Please tell us a little about how we can help.'
        : v.length < 10 ? 'Please add a few more details, at least 10 characters.'
          : v.length > 5000 ? 'Please keep your message under 5000 characters.' : ''),
    };

    const fieldEl = (name) => form.elements.namedItem(name);
    const clearErrors = () => {
      errorBox.hidden = true;
      errorBox.textContent = '';
      Object.keys(rules).forEach((name) => {
        const input = fieldEl(name);
        const err = $(`[data-error-for="${name}"]`, form);
        if (input) input.removeAttribute('aria-invalid');
        if (err) { err.hidden = true; err.textContent = ''; }
      });
    };

    const showErrors = (errors) => {
      const names = Object.keys(errors);
      if (!names.length) return;
      names.forEach((name) => {
        const input = fieldEl(name);
        const err = $(`[data-error-for="${name}"]`, form);
        if (input) input.setAttribute('aria-invalid', 'true');
        if (err) { err.textContent = errors[name]; err.hidden = false; }
      });
      const heading = document.createElement('p');
      heading.textContent = names.length === 1 ? 'Please fix 1 field before sending:' : `Please fix ${names.length} fields before sending:`;
      const list = document.createElement('ul');
      names.forEach((name) => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        const input = fieldEl(name);
        link.href = input ? `#${input.id}` : '#';
        link.textContent = `${labels[name] || name}: ${errors[name]}`;
        link.addEventListener('click', (ev) => { ev.preventDefault(); if (input) input.focus(); });
        li.appendChild(link);
        list.appendChild(li);
      });
      errorBox.append(heading, list);
      errorBox.hidden = false;
      errorBox.focus();
    };

    const validate = () => {
      const errors = {};
      Object.entries(rules).forEach(([name, rule]) => {
        const input = fieldEl(name);
        const msg = rule(input ? input.value.trim() : '');
        if (msg) errors[name] = msg;
      });
      return errors;
    };

    // Re validate a field once the visitor fixes it
    form.addEventListener('input', (e) => {
      const name = e.target.name;
      if (!rules[name] || e.target.getAttribute('aria-invalid') !== 'true') return;
      if (!rules[name](e.target.value.trim())) {
        e.target.removeAttribute('aria-invalid');
        const err = $(`[data-error-for="${name}"]`, form);
        if (err) { err.hidden = true; err.textContent = ''; }
      }
    });

    const setBusy = (busy) => {
      submit.disabled = busy;
      submit.setAttribute('aria-busy', String(busy));
      submitLabel.textContent = busy ? 'Sending' : 'Send message';
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors();
      status.textContent = '';
      status.classList.remove('is-error');
      const errors = validate();
      if (Object.keys(errors).length) { showErrors(errors); return; }

      const data = Object.fromEntries(new FormData(form).entries());
      setBusy(true);
      status.textContent = 'Sending your message.';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(data),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          status.textContent = '';
          form.hidden = true;
          success.hidden = false;
          success.focus();
          if (motionOn) gsap.from(success, { opacity: 0, y: 30, duration: 1, ease: 'expo.out' });
          return;
        }
        if (res.status === 422 && body.fields) { status.textContent = ''; showErrors(body.fields); return; }
        throw new Error(body.error || `Request failed with status ${res.status}`);
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = 'Sorry, your message could not be sent right now. Please email contact@thesocialclubkids.com or call (626) 765 1724.';
      } finally {
        setBusy(false);
        if (window.turnstile && turnstileSlot.dataset.widgetId) window.turnstile.reset(turnstileSlot.dataset.widgetId);
      }
    });

    // Optional Cloudflare Turnstile, enabled when the Worker exposes a site key
    let turnstileRequested = false;
    const loadTurnstile = () => {
      if (turnstileRequested) return;
      turnstileRequested = true;
      fetch('/api/config', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
          if (!cfg || !cfg.turnstileSiteKey) return;
          window.onTscTurnstileLoad = () => {
            const id = window.turnstile.render(turnstileSlot, {
              sitekey: cfg.turnstileSiteKey,
              appearance: 'interaction-only',
              theme: 'light',
              'response-field-name': 'turnstileToken',
            });
            turnstileSlot.dataset.widgetId = id;
          };
          const s = document.createElement('script');
          s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTscTurnstileLoad';
          s.async = true;
          s.defer = true;
          document.head.appendChild(s);
        })
        .catch(() => {});
    };
    if ('IntersectionObserver' in window) {
      const fio = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) { loadTurnstile(); fio.disconnect(); }
      }, { rootMargin: '600px 0px' });
      fio.observe(form);
    } else {
      loadTurnstile();
    }
    form.addEventListener('focusin', loadTurnstile, { once: true });
  }

  /* Text splitting for word reveals. Screen readers get the original text once;
     the animated copy is hidden from assistive tech. */
  function splitWords(el, masked) {
    if (el.dataset.splitReady) return $$(masked ? '.sw__i' : '.sw-plain', el);
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const visual = document.createElement('span');
    visual.setAttribute('aria-hidden', 'true');
    while (el.firstChild) visual.appendChild(el.firstChild);
    const words = [];
    (function walk(node) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            if (masked) {
              const outer = document.createElement('span');
              outer.className = 'sw';
              const inner = document.createElement('span');
              inner.className = 'sw__i';
              inner.textContent = part;
              outer.appendChild(inner);
              frag.appendChild(outer);
              words.push(inner);
            } else {
              const w = document.createElement('span');
              w.className = 'sw-plain';
              w.textContent = part;
              frag.appendChild(w);
              words.push(w);
            }
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      });
    })(visual);
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = text;
    el.append(sr, visual);
    el.dataset.splitReady = '1';
    return words;
  }

  /* Motion
     The hero animates on the first frame. Everything else is set up in small
     chunks right after, so the page becomes interactive sooner on slower phones. */
  function setupMotion(ctx) {
    motionOn = true;
    root.classList.add('motion');

    if (Lenis) {
      lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 1 });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(lenisRaf);
      gsap.ticker.lagSmoothing(0);
    }

    const api = { hTween: null, distanceOf: () => 0, ready: false };
    const gutterPx = () => parseFloat(getComputedStyle($('.container')).paddingLeft) || 16;
    const radiusPx = () => Math.min(40, Math.max(20, window.innerWidth * 0.026));

    /* Hero intro (first frame). Text stays visible; only words slide up from their masks. */
    const heroWords = $$('[data-hero-word]');
    const heroFade = $$('[data-hero-fade]');
    const capsule = $('[data-hero-capsule]');
    const frame = $('[data-hero-frame]');
    const intro = gsap.timeline({ defaults: { ease: 'expo.out' } });
    intro
      .fromTo(heroWords, { y: 0, yPercent: 105 }, { yPercent: 0, duration: 1.5, stagger: 0.12 }, 0.1)
      .fromTo(heroFade, { y: 24 }, { y: 0, duration: 1.4, stagger: 0.15 }, 0.45);
    if (capsule) {
      intro.fromTo(capsule, { scale: 0 }, { scale: 1, duration: 1.4 }, 0.6)
        .fromTo($('img', capsule), { scale: 1.6 }, { scale: 1, duration: 1.8 }, 0.6);
    }
    if (frame) {
      intro.fromTo(frame, { y: 120, opacity: 0 }, { y: 0, opacity: 1, duration: 1.6 }, 0.35)
        .from($('picture', frame), { scale: 1.25, duration: 2.2 }, 0.35);
      gsap.fromTo(frame,
        { clipPath: () => `inset(0px ${gutterPx()}px 0px ${gutterPx()}px round ${radiusPx()}px)` },
        {
          clipPath: 'inset(0px 0px 0px 0px round 0px)',
          ease: 'none',
          scrollTrigger: { trigger: frame, start: 'top 85%', end: 'top 10%', scrub: true, invalidateOnRefresh: true },
        });
      gsap.fromTo($('img', frame), { yPercent: -6, scale: 1.14 }, {
        yPercent: 6, scale: 1.14, ease: 'none',
        scrollTrigger: { trigger: frame, start: 'top bottom', end: 'bottom top', scrub: true },
      });
    }
    gsap.to('.hero__inner', {
      yPercent: -18, ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
    });

    const tasks = [
      /* Clubs: pinned horizontal scroll. Created before the triggers below it so
         they measure their positions with the pin spacing already in place. */
      () => {
        const hpin = $('[data-hpin]');
        const track = hpin && $('[data-hpin-track]', hpin);
        if (!hpin || !track) return;
        root.classList.add('is-hpin');
        const distance = () => Math.max(0, track.scrollWidth - window.innerWidth);
        const indexEl = $('[data-hpin-index]', hpin);
        const cards = $$('[data-club]', hpin);
        api.distanceOf = distance;
        api.hTween = gsap.to(track, {
          x: () => -distance(),
          ease: 'none',
          scrollTrigger: {
            trigger: hpin,
            start: 'top top',
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 0.8,
            anticipatePin: 1,
            invalidateOnRefresh: true,
            onUpdate: (self) => {
              if (!indexEl) return;
              const i = Math.min(cards.length, Math.max(1, Math.round(self.progress * (cards.length - 1)) + 1));
              indexEl.textContent = String(i).padStart(2, '0');
            },
          },
        });
        cards.forEach((card) => {
          const pic = $('.club__media picture', card);
          if (!pic) return;
          gsap.fromTo(pic, { xPercent: -7, scale: 1.18 }, {
            xPercent: 7, scale: 1.18, ease: 'none',
            scrollTrigger: { trigger: card, containerAnimation: api.hTween, start: 'left right', end: 'right left', scrub: true },
          });
        });
      },

      /* Masked word reveals for headings */
      () => {
        $$('[data-split]').forEach((el) => {
          const words = splitWords(el, true);
          gsap.fromTo(words, { yPercent: 110 }, {
            yPercent: 0, duration: 1.2, stagger: 0.06, ease: 'expo.out',
            scrollTrigger: { trigger: el, start: 'top 88%', once: true },
          });
        });
      },

      /* Statement: words darken as you scroll. The starting gray still meets the
         3:1 contrast minimum for large text, so it is readable at every point. */
      () => {
        $$('[data-scrub-words]').forEach((el) => {
          const words = splitWords(el, false);
          gsap.fromTo(words, { color: '#86847c' }, {
            color: '#0f0f0e', stagger: 0.1, ease: 'none',
            scrollTrigger: { trigger: el, start: 'top 82%', end: 'bottom 48%', scrub: true },
          });
        });
      },

      /* Fade ups */
      () => {
        ScrollTrigger.batch('[data-fade]', {
          start: 'top 90%',
          once: true,
          onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 1.2, stagger: 0.09, ease: 'expo.out', overwrite: true }),
        });
      },

      /* Image clip reveals */
      () => {
        $$('[data-reveal]').forEach((el) => {
          gsap.fromTo(el,
            { clipPath: () => `inset(100% 0% 0% 0% round ${radiusPx()}px)` },
            {
              clipPath: () => `inset(0% 0% 0% 0% round ${radiusPx()}px)`,
              duration: 1.5, ease: 'expo.inOut',
              scrollTrigger: { trigger: el, start: 'top 88%', once: true },
              onComplete: () => gsap.set(el, { clipPath: 'none' }),
            });
        });
      },

      /* Image parallax */
      () => {
        $$('[data-parallax]').forEach((el) => {
          const pic = $('picture', el);
          if (!pic) return;
          gsap.fromTo(pic, { yPercent: -7 }, {
            yPercent: 7, ease: 'none',
            scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true },
          });
        });
      },

      /* Counters, word band, gallery strip, footer logo */
      () => {
        $$('[data-count]').forEach((el) => {
          const end = Number(el.dataset.count);
          const state = { v: 0 };
          el.textContent = '0';
          gsap.to(state, {
            v: end, duration: 2, ease: 'expo.out',
            scrollTrigger: { trigger: el, start: 'top 90%', once: true },
            onUpdate: () => { el.textContent = String(Math.round(state.v)); },
          });
        });

        $$('[data-marquee]').forEach((row) => {
          const dir = Number(row.dataset.marquee) || -1;
          gsap.fromTo(row, { xPercent: dir < 0 ? 0 : -25 }, {
            xPercent: dir < 0 ? -25 : 0, ease: 'none',
            scrollTrigger: { trigger: row.parentElement, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
          });
        });

        const strip = $('[data-hscroll]');
        const stripViewport = $('[data-hscroll-viewport]');
        if (strip && stripViewport) {
          stripViewport.removeAttribute('tabindex');
          gsap.fromTo(strip, { x: 0 }, {
            x: () => -Math.max(0, strip.scrollWidth - window.innerWidth),
            ease: 'none',
            scrollTrigger: { trigger: stripViewport, start: 'top bottom', end: 'bottom top', scrub: 0.6, invalidateOnRefresh: true },
          });
        }

        const footLogo = $('[data-footer-logo]');
        if (footLogo) {
          gsap.from(footLogo, { yPercent: 25, opacity: 0, duration: 1.4, ease: 'expo.out', scrollTrigger: { trigger: footLogo, start: 'top 95%', once: true } });
        }
      },
    ];

    let cancelled = false;
    const runNext = () => {
      if (cancelled) return;
      const task = tasks.shift();
      if (task) {
        ctx.add(task);
        window.setTimeout(runNext, 0);
        return;
      }
      api.ready = true;
      ScrollTrigger.refresh();
      if (window.location.hash.length > 1) {
        const t = document.getElementById(window.location.hash.slice(1));
        if (t) scrollToTarget(t, true);
      }
    };
    window.requestAnimationFrame(() => window.setTimeout(runNext, 0));

    api.cancel = () => { cancelled = true; };
    return api;
  }

  function lenisRaf(time) {
    if (lenis) lenis.raf(time * 1000);
  }

  function teardownMotion() {
    motionOn = false;
    root.classList.remove('motion', 'is-hpin');
    if (lenis) {
      gsap.ticker.remove(lenisRaf);
      lenis.destroy();
      lenis = null;
    }
    const stripViewport = $('[data-hscroll-viewport]');
    if (stripViewport) stripViewport.setAttribute('tabindex', '0');
  }

  let motionApi = null;
  if (motionLibs) {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', (ctx) => {
      motionApi = setupMotion(ctx);
      return () => {
        if (motionApi) motionApi.cancel();
        motionApi = null;
        teardownMotion();
      };
    });

    /* Keep keyboard focus visible inside the pinned clubs track */
    const hpin = $('[data-hpin]');
    if (hpin) {
      hpin.addEventListener('focusin', (e) => {
        if (!motionApi || !motionApi.hTween) return;
        const card = e.target.closest('[data-club]');
        const st = motionApi.hTween.scrollTrigger;
        const dist = motionApi.distanceOf();
        if (!card || !st || !dist) return;
        const trackEl = $('[data-hpin-track]', hpin);
        const offset = card.getBoundingClientRect().left - trackEl.getBoundingClientRect().left;
        const wanted = Math.min(dist, Math.max(0, offset - parseFloat(getComputedStyle(trackEl).paddingLeft)));
        const y = st.start + (wanted / dist) * (st.end - st.start);
        scrollToTarget(y, true);
      });
    }

    /* Magnetic buttons on precise pointers */
    $$('[data-magnetic]').forEach((btn) => {
      const xTo = gsap.quickTo(btn, 'x', { duration: 0.6, ease: 'expo.out' });
      const yTo = gsap.quickTo(btn, 'y', { duration: 0.6, ease: 'expo.out' });
      btn.addEventListener('pointermove', (e) => {
        if (!motionOn || !finePointer.matches) return;
        const r = btn.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.22);
        yTo((e.clientY - r.top - r.height / 2) * 0.3);
      });
      btn.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
    });

    /* Recalculate once fonts and late images settle */
    const settle = () => { if (motionApi && motionApi.ready) ScrollTrigger.refresh(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
    if (document.readyState !== 'complete') window.addEventListener('load', settle, { once: true });
  }
})();
