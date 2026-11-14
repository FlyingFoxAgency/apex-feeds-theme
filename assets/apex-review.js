/*
 * APEX "Leave a review" page (sections/apex-review-form.liquid).
 * - Fills the product card from the printed product JSON, using ?product=<handle>&variant=<id>.
 * - Star rating input, photo picker (Judge.me only), validation.
 * - Email mode: the form posts to Shopify's contact form as normal. The review is kept in
 *   sessionStorage so the reloaded page can show it in the thank-you view.
 * - Judge.me mode: posts the review to Judge.me and swaps to the thank-you view in place.
 */
const STORE_KEY = 'apex-review-last';
const MAX_PHOTOS = 5;

const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
};

const readStore = () => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
};

const writeStore = (value) => {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    /* private mode: the thank-you view just shows without the preview */
  }
};

class ApexReviewForm extends HTMLElement {
  connectedCallback() {
    this.mode = this.dataset.mode || 'email';
    this.form = this.querySelector('form');
    this.errorBox = this.querySelector('[data-error]');
    this.photos = [];

    try {
      this.products = JSON.parse(this.querySelector('[data-products]')?.textContent || '{}');
    } catch {
      this.products = {};
    }

    if (this.form) this.form.noValidate = true;
    const changeText = this.querySelector('[data-change-text]');
    if (changeText) changeText.dataset.default = changeText.textContent;

    // Returning from a sent email-mode form
    if (this.querySelector('[data-posted]')) {
      this.showDone(readStore());
      return;
    }

    const params = new URLSearchParams(window.location.search);
    this.setProduct(params.get('product'), params.get('variant'), false);

    this.bindPicker();
    this.bindStars();
    this.bindPhotos();
    this.form?.addEventListener('submit', (event) => this.onSubmit(event));
    this.form?.addEventListener('input', (event) => {
      if (event.target.getAttribute('aria-invalid') === 'true') event.target.removeAttribute('aria-invalid');
    });
  }

  /* Product card */
  setProduct(handle, variantId, updateUrl = true) {
    const product = handle ? this.products[handle] : null;
    this.product = product ? { handle, ...product } : null;
    this.variantTitle = product && variantId ? product.variants?.[variantId] || '' : '';

    const info = this.querySelector('[data-product-info]');
    const image = this.querySelector('[data-product-image]');
    const picker = this.querySelector('[data-picker]');
    const select = this.querySelector('[data-product-select]');
    const toggle = this.querySelector('[data-change-toggle]');
    const changeText = this.querySelector('[data-change-text]');

    if (!product) {
      if (info) info.hidden = true;
      if (picker) picker.hidden = false;
      if (toggle) toggle.hidden = true;
      if (changeText) changeText.textContent = 'Which product are you reviewing?';
      return;
    }

    if (changeText) changeText.textContent = changeText.dataset.default || changeText.textContent;
    if (toggle) toggle.hidden = false;
    if (select) select.value = handle;

    if (image) {
      image.replaceChildren();
      if (product.image) {
        const img = document.createElement('img');
        img.src = product.image;
        img.alt = product.imageAlt || product.title;
        img.loading = 'lazy';
        image.append(img);
      }
    }

    this.querySelector('[data-product-range]').textContent = product.range || '';
    this.querySelector('[data-product-title]').textContent = product.title;
    this.querySelector('[data-product-meta]').textContent = this.variantTitle;

    const rating = Number(product.rating) || 0;
    const ratingRow = this.querySelector('[data-product-rating]');
    if (ratingRow) {
      ratingRow.hidden = rating <= 0;
      this.querySelector('[data-product-stars]')?.style.setProperty('--apex-stars', `${(rating / 5) * 100}%`);
      const count = Number(product.count) || 0;
      const text = count > 0 ? `${rating.toFixed(1)} · ${count} review${count === 1 ? '' : 's'}` : rating.toFixed(1);
      this.querySelector('[data-product-rating-text]').textContent = text;
      ratingRow.setAttribute('aria-label', `Rated ${rating.toFixed(1)} out of 5${count ? ` from ${count} reviews` : ''}`);
    }
    if (info) info.hidden = false;

    const productField = this.querySelector('[data-field-product]');
    if (productField) productField.value = this.variantTitle ? `${product.title} (${this.variantTitle.replaceAll(' · ', ' / ')})` : product.title;
    const urlField = this.querySelector('[data-field-product-url]');
    if (urlField) urlField.value = new URL(product.url, window.location.origin).href;

    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('product', handle);
      url.searchParams.delete('variant');
      window.history.replaceState(null, '', url);
    }
  }

  bindPicker() {
    const toggle = this.querySelector('[data-change-toggle]');
    const picker = this.querySelector('[data-picker]');
    const select = this.querySelector('[data-product-select]');

    toggle?.addEventListener('click', () => {
      const open = picker.hidden;
      picker.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) select?.focus();
    });

    select?.addEventListener('change', () => {
      if (!select.value) return;
      this.setProduct(select.value, null);
      if (this.product && toggle) {
        picker.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
      }
      this.clearError();
    });
  }

  /* Stars */
  bindStars() {
    const inputs = [...this.querySelectorAll('[data-stars] input')];
    const labels = [...this.querySelectorAll('[data-stars] label')];
    const text = this.querySelector('[data-rating-text]');
    const paint = (value) => labels.forEach((label, i) => label.classList.toggle('is-on', i < value));
    const checked = () => Number(inputs.find((input) => input.checked)?.value || 0);

    inputs.forEach((input) => {
      input.addEventListener('change', () => {
        paint(Number(input.value));
        if (text) text.textContent = `${input.value} out of 5, ${input.dataset.word}`;
        this.querySelector('.apex-review-form__rating')?.removeAttribute('data-invalid');
      });
    });
    labels.forEach((label) => {
      label.addEventListener('mouseenter', () => paint(Number(label.dataset.star)));
      label.addEventListener('mouseleave', () => paint(checked()));
    });
  }

  /* Photos (Judge.me mode) */
  bindPhotos() {
    const input = this.querySelector('[data-photos]');
    const drop = this.querySelector('[data-drop]');
    if (!input || !drop) return;

    input.addEventListener('change', () => {
      this.addPhotos(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('is-over');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, () => drop.classList.remove('is-over'))
    );
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      this.addPhotos(event.dataTransfer?.files);
    });
  }

  addPhotos(files) {
    const list = this.querySelector('[data-thumbs]');
    for (const file of files || []) {
      if (this.photos.length >= MAX_PHOTOS) break;
      if (!/^image\/(jpeg|png)$/.test(file.type)) continue;
      if (file.size > 10 * 1024 * 1024) continue;
      this.photos.push(file);
    }
    list.replaceChildren(
      ...this.photos.map((file, index) => {
        const li = document.createElement('li');
        li.className = 'apex-review-form__thumb';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.alt = file.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.addEventListener('click', () => {
          this.photos.splice(index, 1);
          this.addPhotos([]);
        });
        li.append(img, remove);
        return li;
      })
    );
  }

  /* Validation + sending */
  showError(message, focusEl) {
    if (this.errorBox) {
      this.errorBox.textContent = message;
      this.errorBox.hidden = false;
    }
    focusEl?.focus();
    (focusEl || this.errorBox)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  clearError() {
    if (this.errorBox) this.errorBox.hidden = true;
  }

  validate() {
    const f = (name) => this.form.querySelector(`[data-field="${name}"]`);
    const missing = [];
    let first = null;
    const flag = (el, label) => {
      missing.push(label);
      if (el && el.type !== 'checkbox' && el.type !== 'radio') el.setAttribute('aria-invalid', 'true');
      first = first || el;
    };

    if (!this.product) flag(this.querySelector('[data-product-select]'), 'the product');
    const rating = this.form.querySelector('[data-stars] input:checked');
    if (!rating) {
      this.querySelector('.apex-review-form__rating')?.setAttribute('data-invalid', '');
      flag(this.form.querySelector('[data-stars] input'), 'a star rating');
    }
    if (!f('title').value.trim()) flag(f('title'), 'a review title');
    if (!f('body').value.trim()) flag(f('body'), 'your review');
    if (!f('name').value.trim()) flag(f('name'), 'your name');
    const email = f('email').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) flag(f('email'), 'a valid email');
    const consent = f('consent');
    consent.closest('.apex-review-form__consent')?.toggleAttribute('data-invalid', !consent.checked);
    if (!consent.checked) flag(consent, 'the confirm tick');

    if (missing.length) {
      const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
      this.showError(`Please add ${list}.`, first);
      return null;
    }

    return {
      rating: Number(rating.value),
      title: f('title').value.trim(),
      body: f('body').value.trim(),
      name: f('name').value.trim(),
      email,
      species: f('species')?.value || '',
      age: f('age')?.value || '',
    };
  }

  async onSubmit(event) {
    this.clearError();
    const review = this.validate();
    if (!review) {
      event.preventDefault();
      return;
    }

    const saved = {
      rating: review.rating,
      title: review.title,
      body: review.body,
      name: shortName(review.name),
      species: review.species,
      age: review.age,
      product: this.product ? { title: this.product.title, url: this.product.url } : null,
    };
    writeStore(saved);

    if (this.mode !== 'judgeme') return; // email: the browser posts the contact form

    event.preventDefault();
    const button = this.querySelector('[data-submit]');
    button?.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(this.dataset.judgemeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          shop_domain: this.dataset.shopDomain,
          platform: 'shopify',
          id: this.product.id,
          name: review.name,
          email: review.email,
          rating: review.rating,
          title: review.title,
          body: [review.body, [review.species, review.age].filter(Boolean).join(', ')].filter(Boolean).join('\n\n'),
        }),
      });
      if (!response.ok) throw new Error(`Judge.me ${response.status}`);
      this.showDone(saved);
    } catch (error) {
      console.error(error);
      this.showError('Sorry, your review could not be sent. Please try again in a moment.');
    } finally {
      button?.removeAttribute('aria-busy');
    }
  }

  /* Thank-you view */
  showDone(review) {
    const formView = this.querySelector('[data-view="form"]');
    const done = this.querySelector('[data-view="done"]');
    if (formView) formView.hidden = true;
    if (!done) return;
    done.hidden = false;

    const text = this.querySelector('[data-done-text]');
    if (text?.dataset.template) {
      text.textContent = text.dataset.template.replace('[product]', review?.product?.title || 'this product');
    }

    if (review) {
      const stars = this.querySelector('[data-preview-stars]');
      stars?.style.setProperty('--apex-stars', `${(review.rating / 5) * 100}%`);
      stars?.setAttribute('aria-label', `Rated ${review.rating} out of 5`);
      this.querySelector('[data-preview-title]').textContent = review.title;
      this.querySelector('[data-preview-body]').textContent = review.body;
      const animal = [review.species, review.age && review.age.toLowerCase()].filter(Boolean).join(', ');
      this.querySelector('[data-preview-meta]').textContent = [review.name, animal].filter(Boolean).join('  ·  ');
      this.querySelector('[data-preview]').hidden = false;

      const back = this.querySelector('[data-back-link]');
      if (back && review.product?.url) {
        back.href = review.product.url;
        back.hidden = false;
      }
    }

    window.scrollTo({ top: 0 });
    done.focus({ preventScroll: true });
  }
}

if (!customElements.get('apex-review-form')) customElements.define('apex-review-form', ApexReviewForm);
