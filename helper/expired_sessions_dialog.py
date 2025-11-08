"""
Expired Sessions Renewal Dialog.
Shows expired sessions and asks user if they want to renew them.
"""

import tkinter as tk
from tkinter import ttk
import json
import sys

class ExpiredSessionsDialog:
    def __init__(self, expired_sessions):
        self.expired_sessions = expired_sessions
        self.result = None

        # Create main window
        self.root = tk.Tk()
        self.root.title("Shipping Manager CoPilot - Expired Sessions")
        self.root.geometry("650x500")
        self.root.resizable(False, False)

        # Hide window initially
        self.root.withdraw()

        # Configure colors
        self.bg_color = "#111827"
        self.fg_color = "#e0e0e0"
        self.accent_color = "#3b82f6"
        self.card_bg = "#1f2937"
        self.warning_color = "#fbbf24"

        # Track which session is selected (only one at a time)
        self.selected_user_id = tk.StringVar(value=expired_sessions[0]['user_id'] if expired_sessions else None)

        # Store frames for highlighting
        self.session_frames = {}

        # Configure root
        self.root.configure(bg=self.bg_color)

        # Center window
        self.center_window()

        # Build UI
        self.create_widgets()

        # Handle window close button (X) - same as Skip
        self.root.protocol("WM_DELETE_WINDOW", self.skip)

        # Show window
        self.root.deiconify()

        # Make modal
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
            text="🔄 Refresh Sessions",
            font=("Segoe UI", 18, "bold"),
            bg=self.bg_color,
            fg=self.accent_color
        )
        title_label.pack()

        subtitle_label = tk.Label(
            header_frame,
            text="Select which expired session you want to refresh",
            font=("Segoe UI", 11),
            bg=self.bg_color,
            fg="#9ca3af"
        )
        subtitle_label.pack(pady=(5, 0))

        # Sessions list
        sessions_frame = tk.Frame(self.root, bg=self.bg_color)
        sessions_frame.pack(pady=10, padx=40, fill=tk.BOTH, expand=True)

        for session in self.expired_sessions:
            self.create_session_card(sessions_frame, session)

        # Buttons
        button_frame = tk.Frame(self.root, bg=self.bg_color)
        button_frame.pack(pady=(20, 30), padx=40, fill=tk.X)

        # Configure grid for two equal buttons
        button_frame.grid_columnconfigure(0, weight=1, uniform="button")
        button_frame.grid_columnconfigure(1, weight=1, uniform="button")

        # Cancel button (left)
        cancel_btn = tk.Button(
            button_frame,
            text="Cancel",
            command=self.cancel,
            font=("Segoe UI", 12, "bold"),
            bg="#6b7280",
            fg="white",
            activebackground="#4b5563",
            activeforeground="white",
            relief=tk.FLAT,
            cursor="hand2",
            pady=15,
            borderwidth=0,
            highlightthickness=0
        )
        cancel_btn.grid(row=0, column=0, sticky="ew", padx=(0, 5))

        # Refresh button (right)
        refresh_btn = tk.Button(
            button_frame,
            text="Refresh",
            command=self.refresh,
            font=("Segoe UI", 12, "bold"),
            bg="#3b82f6",
            fg="white",
            activebackground="#2563eb",
            activeforeground="white",
            relief=tk.FLAT,
            cursor="hand2",
            pady=15,
            borderwidth=0,
            highlightthickness=0
        )
        refresh_btn.grid(row=0, column=1, sticky="ew", padx=(5, 0))

        # Hover effects
        def on_cancel_enter(e):
            cancel_btn.configure(bg="#4b5563")
        def on_cancel_leave(e):
            cancel_btn.configure(bg="#6b7280")
        cancel_btn.bind('<Enter>', on_cancel_enter)
        cancel_btn.bind('<Leave>', on_cancel_leave)

        def on_refresh_enter(e):
            refresh_btn.configure(bg="#2563eb")
        def on_refresh_leave(e):
            refresh_btn.configure(bg="#3b82f6")
        refresh_btn.bind('<Enter>', on_refresh_enter)
        refresh_btn.bind('<Leave>', on_refresh_leave)

        # Keyboard shortcuts
        self.root.bind('<Return>', lambda e: self.refresh())
        self.root.bind('<Escape>', lambda e: self.cancel())

        # Initialize highlights (make first session green)
        self.root.after(10, self.update_highlights)

    def create_session_card(self, parent, session):
        """Create a session card with radio button."""
        user_id = session['user_id']

        frame = tk.Frame(
            parent,
            bg=self.card_bg,
            highlightbackground="#4b5563",
            highlightthickness=2,
            cursor="hand2"
        )
        frame.pack(pady=8, fill=tk.X)

        # Store frame for highlighting
        self.session_frames[user_id] = frame

        # Bind click to select this session
        def select_this_session(event=None):
            self.selected_user_id.set(user_id)
            self.update_highlights()

        frame.bind('<Button-1>', select_this_session)

        # Content
        content_frame = tk.Frame(frame, bg=self.card_bg, cursor="hand2")
        content_frame.pack(fill=tk.X, padx=20, pady=15)
        content_frame.bind('<Button-1>', select_this_session)

        # Company name
        company_label = tk.Label(
            content_frame,
            text=f"🏢 {session['company_name']}",
            font=("Segoe UI", 12, "bold"),
            bg=self.card_bg,
            fg=self.fg_color,
            cursor="hand2"
        )
        company_label.pack(anchor=tk.W)
        company_label.bind('<Button-1>', select_this_session)

        # User ID and method
        info_text = f"User ID: {session['user_id']} • Method: {session['login_method']}"
        info_label = tk.Label(
            content_frame,
            text=info_text,
            font=("Segoe UI", 9),
            bg=self.card_bg,
            fg="#9ca3af",
            cursor="hand2"
        )
        info_label.pack(anchor=tk.W, pady=(5, 0))
        info_label.bind('<Button-1>', select_this_session)

    def update_highlights(self):
        """Update border colors based on selection."""
        selected = self.selected_user_id.get()

        for user_id, frame in self.session_frames.items():
            if user_id == selected:
                # Green border for selected
                frame.configure(highlightbackground="#10b981", highlightthickness=3)
            else:
                # Gray border for unselected
                frame.configure(highlightbackground="#4b5563", highlightthickness=2)

    def refresh(self):
        """Handle refresh button - refresh selected session."""
        selected = self.selected_user_id.get()

        self.result = {
            'action': 'renew',
            'selected_user_ids': [selected] if selected else []
        }
        self.root.quit()
        self.root.destroy()

    def cancel(self):
        """Handle cancel button - return to session selector."""
        self.result = {'action': 'cancel'}
        self.root.quit()
        self.root.destroy()

    def show(self):
        """Show dialog and return result."""
        self.root.mainloop()
        return self.result

if __name__ == "__main__":
    # Expect JSON array of expired sessions as first argument
    if len(sys.argv) < 2:
        print("Usage: python expired-sessions-dialog.py '<json_array>'", file=sys.stderr)
        sys.exit(1)

    try:
        expired_sessions = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON: {e}", file=sys.stderr)
        sys.exit(1)

    dialog = ExpiredSessionsDialog(expired_sessions)
    result = dialog.show()

    if result:
        # Print result as JSON
        print(json.dumps(result))
        sys.exit(0)
    else:
        sys.exit(1)
