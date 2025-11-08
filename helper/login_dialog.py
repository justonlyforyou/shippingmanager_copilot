"""
Native cross-platform login method selection dialog.
Uses tkinter for native GUI on Windows, macOS, and Linux.
"""

import tkinter as tk
from tkinter import ttk
import platform
import json
import sys

class LoginDialog:
    def __init__(self):
        self.result = None
        self.system = platform.system()

        # Create main window
        self.root = tk.Tk()
        self.root.title("Shipping Manager CoPilot - Login Method")
        self.root.geometry("600x650")
        self.root.resizable(False, False)

        # Hide window initially to prevent flashing
        self.root.withdraw()

        # Set window icon (optional, skip if not available)
        try:
            # You can add an icon file later
            pass
        except:
            pass

        # Configure colors matching app design
        self.bg_color = "#111827"
        self.fg_color = "#e0e0e0"
        self.accent_color = "#3b82f6"
        self.card_bg = "#1f2937"
        self.card_hover = "#374151"

        # Configure root window
        self.root.configure(bg=self.bg_color)

        # Center window on screen
        self.center_window()

        # Selected method
        self.selected_method = tk.StringVar(value="")

        # Build UI
        self.create_widgets()

        # Handle window close button (X) - same as Cancel
        self.root.protocol("WM_DELETE_WINDOW", self.cancel)

        # Show window after everything is ready (prevents flashing)
        self.root.deiconify()

        # Make window modal
        self.root.grab_set()
        self.root.focus_force()

        # Always on top - set AFTER grab_set to avoid conflicts
        self.root.attributes('-topmost', True)

    def center_window(self):
        """Center window on screen."""
        self.root.update_idletasks()
        width = self.root.winfo_width()
        height = self.root.winfo_height()
        x = (self.root.winfo_screenwidth() // 2) - (width // 2)
        y = (self.root.winfo_screenheight() // 2) - (height // 2)
        self.root.geometry(f'{width}x{height}+{x}+{y}')

    def create_widgets(self):
        """Create all UI elements."""

        # Header
        header_frame = tk.Frame(self.root, bg=self.bg_color)
        header_frame.pack(pady=(30, 10), padx=40, fill=tk.X)

        title_label = tk.Label(
            header_frame,
            text="🚢 Shipping Manager CoPilot",
            font=("Segoe UI", 18, "bold"),
            bg=self.bg_color,
            fg=self.accent_color
        )
        title_label.pack()

        subtitle_label = tk.Label(
            header_frame,
            text="Choose Your Login Method",
            font=("Segoe UI", 12),
            bg=self.bg_color,
            fg="#9ca3af"
        )
        subtitle_label.pack(pady=(5, 0))

        # Description
        desc_label = tk.Label(
            self.root,
            text="Select how you want to authenticate with Shipping Manager",
            font=("Segoe UI", 9),
            bg=self.bg_color,
            fg="#9ca3af",
            wraplength=520
        )
        desc_label.pack(pady=(0, 20))

        # Options container
        options_frame = tk.Frame(self.root, bg=self.bg_color)
        options_frame.pack(pady=10, padx=40, fill=tk.BOTH, expand=True)

        # Steam Login Option
        self.steam_frame = self.create_option_card(
            options_frame,
            "steam",
            "🎮  Steam Login",
            "Automatically extracts your session from the Steam client.\nSteam must be running and you must have logged in at least once.",
            "WINDOWS ONLY",
            "#fbbf24"  # Yellow badge
        )
        self.steam_frame.pack(pady=10, fill=tk.X)

        # Disable Steam option on non-Windows
        if self.system != "Windows":
            self.disable_option(self.steam_frame)

        # Browser Login Option
        self.browser_frame = self.create_option_card(
            options_frame,
            "browser",
            "🌐  Browser Login",
            "Opens a browser window where you can log in with any account\n(Gmail, website account, etc.). Works on all platforms.",
            "CROSS-PLATFORM",
            "#3b82f6"  # Blue badge
        )
        self.browser_frame.pack(pady=10, fill=tk.X)

        # Auto-select browser on non-Windows
        if self.system != "Windows":
            self.selected_method.set("browser")
            self.highlight_selection()

        # Platform warning (only on non-Windows)
        if self.system != "Windows":
            warning_frame = tk.Frame(self.root, bg="#451a03", highlightbackground="#fbbf24", highlightthickness=1)
            warning_frame.pack(pady=(10, 0), padx=40, fill=tk.X)

            warning_label = tk.Label(
                warning_frame,
                text=f"⚠️  You're on {self.system}. Steam login is only available on Windows.",
                font=("Segoe UI", 9),
                bg="#451a03",
                fg="#fbbf24",
                justify=tk.LEFT,
                padx=15,
                pady=10
            )
            warning_label.pack()

        # Remember session checkbox
        # Session is always remembered - no checkbox needed
        info_frame = tk.Frame(self.root, bg="#1e3a5f", highlightbackground=self.accent_color, highlightthickness=1)
        info_frame.pack(pady=20, padx=40, fill=tk.X)

        info_label = tk.Label(
            info_frame,
            text="💾 Session will be saved automatically",
            font=("Segoe UI", 10, "italic"),
            bg="#1e3a5f",
            fg="#93c5fd",
            padx=15,
            pady=12
        )
        info_label.pack(anchor=tk.W)

        # Selection hint
        self.hint_label = tk.Label(
            self.root,
            text="↑ Please select a login method above",
            font=("Segoe UI", 10, "italic"),
            bg=self.bg_color,
            fg="#9ca3af"
        )
        if self.system == "Windows":
            self.hint_label.pack(pady=(5, 10))

        # Buttons
        button_frame = tk.Frame(self.root, bg=self.bg_color)
        button_frame.pack(pady=(10, 30), padx=40, fill=tk.X)

        # Cancel button
        cancel_btn = tk.Button(
            button_frame,
            text="✕ Cancel",
            command=self.cancel,
            font=("Segoe UI", 12, "bold"),
            bg="#4b5563",
            fg=self.fg_color,
            activebackground="#6b7280",
            activeforeground=self.fg_color,
            relief=tk.FLAT,
            cursor="hand2",
            padx=40,
            pady=15
        )
        cancel_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 10))

        # Continue button
        self.continue_btn = tk.Button(
            button_frame,
            text="✓ Start Login",
            command=self.continue_action,
            font=("Segoe UI", 13, "bold"),
            bg=self.accent_color,
            fg="white",
            activebackground="#2563eb",
            activeforeground="white",
            relief=tk.FLAT,
            cursor="hand2",
            padx=40,
            pady=15,
            state=tk.DISABLED if self.system == "Windows" else tk.NORMAL
        )
        self.continue_btn.pack(side=tk.RIGHT, expand=True, fill=tk.X, padx=(10, 0))

        # Keyboard shortcuts
        self.root.bind('<Return>', lambda e: self.continue_action() if self.selected_method.get() else None)
        self.root.bind('<Escape>', lambda e: self.cancel())
        self.root.bind('1', lambda e: self.select_option("steam") if self.system == "Windows" else None)
        self.root.bind('2', lambda e: self.select_option("browser"))

    def create_option_card(self, parent, method, title, description, badge_text, badge_color):
        """Create an option card."""
        frame = tk.Frame(
            parent,
            bg=self.card_bg,
            highlightbackground="#4b5563",
            highlightthickness=2,
            cursor="hand2"
        )

        # Store method
        frame.method = method

        # Create bound click handler
        def click_handler(event):
            print(f"[DEBUG] Frame clicked: {method}", file=sys.stderr)
            self.select_option(method)

        # Click handler
        frame.bind('<Button-1>', click_handler)

        # Header with title and badge
        header_frame = tk.Frame(frame, bg=self.card_bg, cursor="hand2")
        header_frame.pack(fill=tk.X, padx=20, pady=(15, 5))
        header_frame.bind('<Button-1>', click_handler)

        title_label = tk.Label(
            header_frame,
            text=title,
            font=("Segoe UI", 12, "bold"),
            bg=self.card_bg,
            fg=self.fg_color,
            cursor="hand2"
        )
        title_label.pack(side=tk.LEFT)
        title_label.bind('<Button-1>', click_handler)

        badge_label = tk.Label(
            header_frame,
            text=badge_text,
            font=("Segoe UI", 8, "bold"),
            bg=badge_color,
            fg="black" if badge_color == "#fbbf24" else "white",
            padx=8,
            pady=2,
            cursor="hand2"
        )
        badge_label.pack(side=tk.LEFT, padx=(10, 0))
        badge_label.bind('<Button-1>', click_handler)

        # Description
        desc_label = tk.Label(
            frame,
            text=description,
            font=("Segoe UI", 9),
            bg=self.card_bg,
            fg="#9ca3af",
            justify=tk.LEFT,
            cursor="hand2",
            wraplength=540
        )
        desc_label.pack(fill=tk.X, padx=20, pady=(0, 15), anchor=tk.W)
        desc_label.bind('<Button-1>', click_handler)

        # Hover effects
        def on_enter(e):
            if frame.method == self.selected_method.get():
                return
            frame.configure(highlightbackground="#60a5fa")

        def on_leave(e):
            if frame.method == self.selected_method.get():
                return
            frame.configure(highlightbackground="#4b5563")

        # Bind hover to all widgets
        for widget in [frame, header_frame, title_label, badge_label, desc_label]:
            widget.bind('<Enter>', on_enter)
            widget.bind('<Leave>', on_leave)

        return frame

    def disable_option(self, frame):
        """Disable an option card."""
        frame.configure(cursor="no")
        for widget in frame.winfo_children():
            widget.configure(cursor="no")
            if isinstance(widget, tk.Frame):
                for child in widget.winfo_children():
                    child.configure(cursor="no")

        # Reduce opacity effect (by changing colors)
        frame.configure(bg="#0f1419")
        for widget in frame.winfo_children():
            if isinstance(widget, tk.Label):
                widget.configure(bg="#0f1419", fg="#4b5563")
            elif isinstance(widget, tk.Frame):
                widget.configure(bg="#0f1419")
                for child in widget.winfo_children():
                    if isinstance(child, tk.Label):
                        child.configure(bg="#0f1419", fg="#4b5563")

        # Unbind click events
        frame.unbind('<Button-1>')
        frame.unbind('<Enter>')
        frame.unbind('<Leave>')

    def select_option(self, method):
        """Select an option."""
        print(f"[DEBUG] select_option called with method: {method}", file=sys.stderr)

        # Check if Steam on non-Windows
        if method == "steam" and self.system != "Windows":
            print(f"[DEBUG] Steam blocked on non-Windows", file=sys.stderr)
            return

        print(f"[DEBUG] Setting selected_method to: {method}", file=sys.stderr)
        self.selected_method.set(method)
        print(f"[DEBUG] Enabling continue button", file=sys.stderr)
        self.continue_btn.configure(state=tk.NORMAL, bg="#10b981")  # Green when ready

        # Hide hint label
        if hasattr(self, 'hint_label'):
            self.hint_label.pack_forget()

        print(f"[DEBUG] Calling highlight_selection", file=sys.stderr)
        self.highlight_selection()

    def highlight_selection(self):
        """Highlight selected option."""
        print(f"[DEBUG] highlight_selection: selected={self.selected_method.get()}", file=sys.stderr)

        # Reset all
        for frame in [self.steam_frame, self.browser_frame]:
            if frame.method != self.selected_method.get():
                frame.configure(highlightbackground="#4b5563", highlightthickness=2)
                print(f"[DEBUG] Reset border for {frame.method}", file=sys.stderr)

        # Highlight selected
        selected = self.selected_method.get()
        if selected == "steam":
            self.steam_frame.configure(highlightbackground=self.accent_color, highlightthickness=3)
            print(f"[DEBUG] Highlighted steam frame", file=sys.stderr)
        elif selected == "browser":
            self.browser_frame.configure(highlightbackground=self.accent_color, highlightthickness=3)
            print(f"[DEBUG] Highlighted browser frame", file=sys.stderr)

        # Force GUI update
        self.root.update_idletasks()
        print(f"[DEBUG] GUI updated", file=sys.stderr)

    def continue_action(self):
        """Handle continue button."""
        if not self.selected_method.get():
            return

        self.result = {
            "method": self.selected_method.get()
        }
        self.root.quit()
        self.root.destroy()

    def cancel(self):
        """Handle cancel button - return to session selector."""
        self.result = {"action": "cancel"}
        self.root.quit()
        self.root.destroy()

    def show(self):
        """Show dialog and return result."""
        self.root.mainloop()
        return self.result

if __name__ == "__main__":
    dialog = LoginDialog()
    result = dialog.show()

    if result:
        # Print result as JSON for Node.js to capture
        print(json.dumps(result))
        sys.exit(0)
    else:
        # User cancelled
        sys.exit(1)
