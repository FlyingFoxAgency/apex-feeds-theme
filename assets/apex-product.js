import { StandardEvents } from '@shopify/events';

/**
 * APEX purchase options: keeps the hidden selling_plan input of the buy buttons form in step with
 * the One-time / Subscribe and Save choice, and re-renders itself when the variant changes.
 */
class ApexPurchaseOptions extends HTMLElement {
  #section = null;

  connectedCallback() {
    this.addEventListener('change', this.#sync);
    this.#section = this.closest('.shopify-section');
    this.#section?.addEventListener(StandardEvents.productSelect, this.#onProductSelect);
    this.#sync();
  }

  disconnectedCallback() {
    this.removeEventListener('change', this.#sync);
    this.#section?.removeEventListener(StandardEvents.productSelect, this.#onProductSelect);
  }

  #sync = () => {
    const input = this.querySelector('[data-plan-input]');
    const select = this.querySelector('[data-plan-select]');
    const chosen = this.querySelector('[data-purchase-type]:checked');
    if (!input) return;

    const subscribe = chosen ? chosen.value === 'subscribe' : true;
    input.value = subscribe && select && !select.disabled ? select.value : '';

    const option = select?.selectedOptions?.[0];
    const priceEl = this.querySelector('[data-sub-price]');
    if (option?.dataset.price && priceEl) priceEl.textContent = option.dataset.price;
  };

  #onProductSelect = (event) => {
    if (event.target instanceof Element && event.target.closest('product-card')) return;
    event.promise
      ?.then(({ detail }) => {
        const html = detail?.html;
        if (!html) return;
        const fresh = html.querySelector(`apex-purchase-options[data-block-id="${this.dataset.blockId}"]`);
        if (!fresh) return;

        const type = this.querySelector('[data-purchase-type]:checked')?.value;
        const plan = this.querySelector('[data-plan-select]')?.value;
        this.innerHTML = fresh.innerHTML;

        const radio = type && this.querySelector(`[data-purchase-type][value="${type}"]`);
        if (radio) radio.checked = true;
        const select = this.querySelector('[data-plan-select]');
        if (select && plan && [...select.options].some((o) => o.value === plan)) select.value = plan;
        this.#sync();
      })
      .catch(() => {});
  };
}

if (!customElements.get('apex-purchase-options')) {
  customElements.define('apex-purchase-options', ApexPurchaseOptions);
}

/**
 * APEX recommendations: fills a product carousel with Shopify's product recommendations for the
 * current product. The section is fetched from /recommendations/products and its track swapped in.
 * When Shopify has nothing to recommend, the fallback cards already on the page stay.
 */
class ApexRecommendations extends HTMLElement {
  connectedCallback() {
    if (this.dataset.loaded) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        this.#load();
      },
      { rootMargin: '0px 0px 400px 0px' }
    );
    observer.observe(this);
  }

  async #load() {
    this.dataset.loaded = 'true';
    const { url } = this.dataset;
    if (!url) return;
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const text = await response.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const freshTrack = doc.querySelector('[data-track][data-recommended]');
      const track = this.querySelector('[data-track]');
      if (freshTrack && track && freshTrack.children.length > 0) {
        track.replaceChildren(...freshTrack.children);
        track.scrollLeft = 0;
        // Let the carousel track the new cards (arrows and the phone fade)
        const carousel = this.closest('apex-carousel');
        for (const item of track.children) carousel?.observer?.observe(item);
        carousel?.update?.();
        this.dataset.recommended = 'true';
      }
    } catch (error) {
      // Keep the fallback cards
    }
  }
}

if (!customElements.get('apex-recommendations')) {
  customElements.define('apex-recommendations', ApexRecommendations);
}

/**
 * Review cards: the Full review button shows only when the text is cut off, and opens the rest of
 * the text in place.
 */
function setUpReviewToggles(root = document) {
  for (const button of root.querySelectorAll('[data-review-toggle]')) {
    if (button.dataset.ready) continue;
    button.dataset.ready = 'true';
    const text = document.getElementById(button.getAttribute('aria-controls'));
    if (!text) continue;
    if (text.scrollHeight > text.clientHeight + 2) button.hidden = false;
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      text.classList.toggle('is-expanded', open);
      button.textContent = open ? 'Show less' : 'Full review';
    });
  }
}

setUpReviewToggles();
document.addEventListener('shopify:section:load', (event) => setUpReviewToggles(event.target));

/**
 * APEX variant content: parts of the product page that follow the selected variant on grouped
 * products (Flavour / Age range pills), e.g. the text under the gallery and the information
 * accordions, which read the variant's own metafields first.
 * - Inside the product information section: swapped from the HTML the variant picker already
 *   fetched.
 * - In another section (data-section-id): that section is fetched for the new variant.
 * Open accordion rows stay open.
 */
class ApexVariantContent extends HTMLElement {
  #abort = null;

  connectedCallback() {
    // Capture phase, so the event is seen here whether or not it bubbles
    document.addEventListener(StandardEvents.productSelect, this.#onProductSelect, true);
  }

  disconnectedCallback() {
    document.removeEventListener(StandardEvents.productSelect, this.#onProductSelect, true);
  }

  #onProductSelect = (event) => {
    const target = event.target;
    if (target instanceof Element && (target.closest('product-card') || target.closest('dialog'))) return;

    event.promise
      ?.then(async ({ variant, detail }) => {
        const html = detail?.html;
        // The variant id can come as a GID (gid://shopify/ProductVariant/123): keep the number only
        const rawId =
          html?.querySelector('input[name="id"]')?.value ?? event.detail?.variantId ?? variant?.id ?? detail?.variantId;
        const variantId = rawId ? String(rawId).split('/').pop() : '';
        if (!variantId) return;

        let source = null;
        if (this.dataset.sectionId) {
          this.#abort?.abort();
          this.#abort = new AbortController();
          const url = new URL(window.location.href);
          url.searchParams.set('variant', variantId);
          url.searchParams.set('section_id', this.dataset.sectionId);
          const response = await fetch(url, { signal: this.#abort.signal });
          if (!response.ok) return;
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          source = doc.querySelector(`apex-variant-content[data-key="${this.dataset.key}"]`);
        } else if (html) {
          source = html.querySelector(`apex-variant-content[data-key="${this.dataset.key}"]`);
        }
        if (!source || source.innerHTML === this.innerHTML) return;

        const openTitles = new Set(
          [...this.querySelectorAll('details[open] summary')].map((summary) => summary.textContent.trim())
        );
        this.innerHTML = source.innerHTML;
        for (const details of this.querySelectorAll('details')) {
          const title = details.querySelector('summary')?.textContent.trim();
          if (openTitles.size) details.open = openTitles.has(title);
        }
      })
      .catch(() => {});
  };
}

if (!customElements.get('apex-variant-content')) {
  customElements.define('apex-variant-content', ApexVariantContent);
}
