/**
 * APEX Feeds home page behaviour: hero slideshow, product carousel and story tabs.
 * Plain custom elements with no dependencies, so each section works on its own.
 */

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * <apex-hero> cross-fades between [data-slide] panels. The [data-dot] buttons on the
 * timeline pick a slide, and the slideshow advances on its own every data-autoplay
 * seconds, pausing while the pointer or keyboard focus is inside it.
 */
class ApexHero extends HTMLElement {
  connectedCallback() {
    this.slides = [...this.querySelectorAll("[data-slide]")];
    this.dots = [...this.querySelectorAll("[data-dot]")];
    this.index = 0;
    this.delay = Number(this.dataset.autoplay || 0) * 1000;

    this.dots.forEach((dot, i) =>
      dot.addEventListener("click", () => this.show(i, true)),
    );
    this.addEventListener("pointerenter", () => this.stop());
    this.addEventListener("pointerleave", () => this.start());
    this.addEventListener("focusin", () => this.stop());
    this.addEventListener("focusout", () => this.start());

    // Theme editor: show the slide being edited
    document.addEventListener("shopify:block:select", (event) => {
      const i = this.slides.findIndex((slide) => slide.contains(event.target));
      if (i >= 0) {
        this.show(i);
        this.stop();
      }
    });

    // Line the slide text up with the first header menu link (Home)
    this.align = this.align.bind(this);
    window.addEventListener("resize", this.align);
    document.fonts?.ready.then(this.align);
    this.align();

    this.show(0);
    this.start();
  }

  disconnectedCallback() {
    this.stop();
    window.removeEventListener("resize", this.align);
  }

  // Sets --apex-hero-text-x to where the first menu link's text starts, measured from the left
  // of the hero stage. Without a desktop menu the CSS keeps the Figma position.
  align() {
    const title = document.querySelector(
      "#header-component .header-menu .menu-list__link-title",
    );
    const text =
      title &&
      [...title.childNodes].find(
        (node) => node.nodeType === 3 && node.textContent.trim(),
      );
    if (!text || !title.getClientRects().length) {
      this.style.removeProperty("--apex-hero-text-x");
      return;
    }
    const range = document.createRange();
    const start = text.textContent.search(/\S/);
    range.setStart(text, start);
    range.setEnd(text, start + 1);
    const x =
      range.getBoundingClientRect().left - this.getBoundingClientRect().left;
    this.style.setProperty(
      "--apex-hero-text-x",
      `${Math.max(0, Math.round(x))}px`,
    );
  }

  show(index, fromUser = false) {
    if (!this.slides.length) return;
    this.index = (index + this.slides.length) % this.slides.length;
    this.slides.forEach((slide, i) => {
      const active = i === this.index;
      slide.classList.toggle("is-active", active);
      slide.toggleAttribute("inert", !active);
      slide.setAttribute("aria-hidden", String(!active));
    });
    this.dots.forEach((dot, i) => {
      const active = i === this.index;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-current", String(active));
    });
    if (fromUser) this.start();
  }

  start() {
    this.stop();
    if (!this.delay || this.slides.length < 2 || reducedMotion()) return;
    this.timer = setInterval(() => this.show(this.index + 1), this.delay);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * <apex-carousel> wraps a horizontally scrolling [data-track]. [data-prev]/[data-next]
 * scroll by one item and are disabled at either end.
 */
class ApexCarousel extends HTMLElement {
  connectedCallback() {
    this.track = this.querySelector("[data-track]");
    this.prev = this.querySelector("[data-prev]");
    this.next = this.querySelector("[data-next]");
    if (!this.track) return;

    this.prev?.addEventListener("click", () => this.step(-1));
    this.next?.addEventListener("click", () => this.step(1));
    this.track.addEventListener("scroll", () => this.update(), {
      passive: true,
    });
    new ResizeObserver(() => this.update()).observe(this.track);
    this.update();
  }

  step(direction) {
    const item = this.track.firstElementChild;
    if (!item) return;
    const gap = parseFloat(getComputedStyle(this.track).columnGap) || 0;
    this.track.scrollBy({
      left: direction * (item.getBoundingClientRect().width + gap),
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }

  update() {
    const { scrollLeft, scrollWidth, clientWidth } = this.track;
    const atStart = scrollLeft <= 1;
    const atEnd = scrollLeft + clientWidth >= scrollWidth - 1;
    if (this.prev) this.prev.disabled = atStart;
    if (this.next) this.next.disabled = atEnd;
    this.toggleAttribute("data-static", atStart && atEnd);
  }
}

/**
 * <apex-tabs> pairs [data-tab] buttons with [data-panel] slides in a scrolling
 * [data-track]. Picking a tab (or clicking the slide peeking in from the right)
 * makes that slide current and scrolls it into place.
 */
class ApexTabs extends HTMLElement {
  connectedCallback() {
    this.track = this.querySelector("[data-track]");
    this.tabs = [...this.querySelectorAll("[data-tab]")];
    this.panels = [...this.querySelectorAll("[data-panel]")];

    this.tabs.forEach((tab, i) =>
      tab.addEventListener("click", () => this.select(i)),
    );
    this.panels.forEach((panel, i) =>
      panel.addEventListener("click", (event) => {
        if (
          !panel.classList.contains("is-active") &&
          !event.target.closest("a")
        )
          this.select(i);
      }),
    );
    this.addEventListener("keydown", (event) => this.onKey(event));

    // Snap the cards to where the first one starts (the track's left padding, in px)
    this.setSnap = () => {
      if (!this.track) return;
      const pad = getComputedStyle(this.track).paddingInlineStart;
      this.track.style.setProperty("--apex-story-snap", pad);
    };
    this.setSnap();
    window.addEventListener("resize", this.setSnap);

    // Scrolling the cards by hand moves the active tab along with them
    if (this.track) {
      this.track.addEventListener("scroll", () => this.onScroll(), {
        passive: true,
      });
      ["wheel", "touchstart", "pointerdown"].forEach((type) =>
        this.track.addEventListener(type, () => (this.target = null), {
          passive: true,
        }),
      );
    }

    document.addEventListener("shopify:block:select", (event) => {
      const i = this.panels.findIndex((panel) => panel.contains(event.target));
      if (i >= 0) this.select(i);
    });

    this.select(0, false);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this.setSnap);
  }

  // The card whose left edge is closest to where the first card sits
  nearest() {
    const start = this.panels[0].offsetLeft + this.track.scrollLeft;
    let best = 0;
    this.panels.forEach((panel, i) => {
      if (
        Math.abs(panel.offsetLeft - start) <
        Math.abs(this.panels[best].offsetLeft - start)
      )
        best = i;
    });
    return best;
  }

  onScroll() {
    if (!this.panels.length) return;
    const index = this.nearest();
    // While a tab click is scrolling the cards, wait until it arrives
    if (this.target != null) {
      if (index === this.target) this.target = null;
      return;
    }
    if (index !== this.current) this.select(index, false);
  }

  select(index, scroll = true) {
    this.current = index;
    this.tabs.forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    this.panels.forEach((panel, i) =>
      panel.classList.toggle("is-active", i === index),
    );
    if (scroll && this.track && this.panels[index]) {
      this.target = index;
      const left = this.panels[index].offsetLeft - this.panels[0].offsetLeft;
      this.track.scrollTo({
        left,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    }
  }

  onKey(event) {
    if (!event.target.matches("[data-tab]")) return;
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next =
      (this.current + keys[event.key] + this.tabs.length) % this.tabs.length;
    this.select(next);
    this.tabs[next].focus();
  }
}

if (!customElements.get("apex-hero"))
  customElements.define("apex-hero", ApexHero);
if (!customElements.get("apex-carousel"))
  customElements.define("apex-carousel", ApexCarousel);
if (!customElements.get("apex-tabs"))
  customElements.define("apex-tabs", ApexTabs);
