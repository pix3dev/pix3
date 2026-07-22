import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { AuthService } from '@/services/cloud/AuthService';
import './pix3-auth-screen.ts.css';

@customElement('pix3-auth-screen')
export class Pix3AuthScreen extends ComponentBase {
  @inject(AuthService)
  private readonly authService!: AuthService;

  @property({ type: String, reflect: true })
  public variant: 'page' | 'modal' = 'page';

  @property({ type: Boolean, reflect: true, attribute: 'show-close' })
  public showClose = false;

  @state() private mode: 'login' | 'register' = 'login';
  @state() private email = '';
  @state() private username = '';
  @state() private password = '';
  @state() private error = '';
  @state() private submitting = false;

  private onInput = (field: 'email' | 'username' | 'password') => (e: Event) => {
    this[field] = (e.target as HTMLInputElement).value;
  };

  private toggleMode = () => {
    this.mode = this.mode === 'login' ? 'register' : 'login';
    this.error = '';
  };

  private onSubmit = async (e: Event) => {
    e.preventDefault();
    this.error = '';
    this.submitting = true;
    try {
      if (this.mode === 'login') {
        await this.authService.login(this.email, this.password);
      } else {
        await this.authService.register(this.email, this.username, this.password);
      }
      this.dispatchEvent(
        new CustomEvent('pix3-auth:success', {
          bubbles: true,
          composed: true,
        })
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Something went wrong';
    } finally {
      this.submitting = false;
    }
  };

  protected render() {
    const title = this.mode === 'login' ? 'Sign In' : 'Create Account';
    const toggleText =
      this.mode === 'login'
        ? "Don't have an account? Register"
        : 'Already have an account? Sign In';

    return html`
      <div class="auth-root auth-root--${this.variant}">
        <div class="auth-card">
          ${this.showClose
            ? html`
                <button class="auth-close" @click=${this.onClose} aria-label="Close authentication">
                  x
                </button>
              `
            : null}
          <img src="/splash-logo.png" alt="Pix3" class="auth-logo" />
          <h2>${title}</h2>

          <form @submit=${this.onSubmit} class="auth-form">
            <label>
              <span>Email</span>
              <input
                type="email"
                .value=${this.email}
                @input=${this.onInput('email')}
                required
                autocomplete="email"
              />
            </label>

            ${this.mode === 'register'
              ? html`<label>
                  <span>Username</span>
                  <input
                    type="text"
                    .value=${this.username}
                    @input=${this.onInput('username')}
                    required
                    autocomplete="username"
                    minlength="2"
                  />
                </label>`
              : null}

            <label>
              <span>Password</span>
              <input
                type="password"
                .value=${this.password}
                @input=${this.onInput('password')}
                required
                autocomplete=${this.mode === 'login' ? 'current-password' : 'new-password'}
                minlength="6"
              />
            </label>

            ${this.error ? html`<div class="auth-error">${this.error}</div>` : null}

            <button type="submit" class="auth-submit" ?disabled=${this.submitting}>
              ${this.submitting ? 'Please wait…' : title}
            </button>
          </form>

          <button class="auth-toggle" @click=${this.toggleMode}>${toggleText}</button>
        </div>
      </div>
    `;
  }

  private onClose = (): void => {
    this.dispatchEvent(
      new CustomEvent('pix3-auth:close', {
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-auth-screen': Pix3AuthScreen;
  }
}
