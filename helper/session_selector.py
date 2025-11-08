"""
Session Selector Dialog - Choose from multiple active sessions.
Shows list of company names for all valid sessions with option to add new session.
"""

import tkinter as tk
from tkinter import ttk
import json
import sys

class SessionSelectorDialog:
    def __init__(self, sessions, expired_sessions=None, show_action_buttons=True):
        """
        Initialize session selector dialog.

        Args:
            sessions: List of dicts with keys: user_id, company_name, timestamp (ACTIVE sessions)
            expired_sessions: List of expired session dicts (INACTIVE sessions)
            show_action_buttons: If False, hide Refresh/Add New buttons (used when selecting session to refresh)
        """
        self.sessions = sessions  # Active sessions
        self.expired_sessions = expired_sessions or []  # Inactive sessions
        self.show_action_buttons = show_action_buttons
        self.result = None

        # Create main window
        self.root = tk.Tk()
        title = "Shipping Manager CoPilot - Refresh Session" if not show_action_buttons else "Shipping Manager CoPilot - Login Session"
        self.root.title(title)
        self.root.geometry("510x600")
        self.root.resizable(False, False)

        # Hide window initially to prevent flashing
        self.root.withdraw()

        # Configure colors
        self.bg_color = "#111827"
        self.fg_color = "#e0e0e0"
        self.accent_color = "#3b82f6"
        self.card_bg = "#1f2937"
        self.card_hover = "#374151"
        self.success_color = "#10b981"

        self.root.configure(bg=self.bg_color)

        # Center window
        self.center_window()

        # Selected session
        self.selected_user_id = tk.StringVar(value="")

        # Build UI
        self.create_widgets()

        # Handle window close button (X) - same as Cancel
        self.root.protocol("WM_DELETE_WINDOW", self.cancel)

        # Show window after everything is ready (prevents flashing)
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
        header_frame.pack(pady=(30, 10), padx=30, fill=tk.X)

        # Dynamic title based on mode
        header_text = "🚢 Select Session for Refresh" if not self.show_action_buttons else "🚢 Select Session for Login"
        title_label = tk.Label(
            header_frame,
            text=header_text,
            font=("Segoe UI", 18, "bold"),
            bg=self.bg_color,
            fg=self.accent_color
        )
        title_label.pack()

        subtitle_text = "Choose which session to refresh" if not self.show_action_buttons else "Choose which account you want to use"
        subtitle_label = tk.Label(
            header_frame,
            text=subtitle_text,
            font=("Segoe UI", 11),
            bg=self.bg_color,
            fg="#9ca3af"
        )
        subtitle_label.pack(pady=(5, 0))

        # Sessions list container with scrollbar (ACTIVE + INACTIVE)
        list_frame = tk.Frame(self.root, bg=self.bg_color)
        list_frame.pack(pady=20, padx=20, fill=tk.BOTH, expand=True)

        # Canvas for scrolling
        canvas = tk.Canvas(list_frame, bg=self.bg_color, highlightthickness=0)

        # Custom styled scrollbar
        scrollbar = tk.Scrollbar(
            list_frame,
            orient="vertical",
            command=canvas.yview,
            bg=self.card_bg,
            troughcolor=self.bg_color,
            activebackground="#60a5fa",
            width=8,
            relief=tk.FLAT,
            borderwidth=0
        )

        # Center container for cards
        scrollable_frame = tk.Frame(canvas, bg=self.bg_color)

        def on_frame_configure(event):
            canvas.configure(scrollregion=canvas.bbox("all"))
            # Only show scrollbar if content is scrollable
            canvas_height = canvas.winfo_height()
            content_height = scrollable_frame.winfo_reqheight()
            if content_height > canvas_height:
                scrollbar.pack(side="right", fill="y", padx=(2, 0))
            else:
                scrollbar.pack_forget()

        def on_canvas_configure(event):
            # Center the scrollable frame in canvas
            canvas_width = event.width
            canvas.itemconfig(canvas_window, width=canvas_width)

        scrollable_frame.bind("<Configure>", on_frame_configure)
        canvas.bind("<Configure>", on_canvas_configure)

        canvas_window = canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        # Session cards - ACTIVE SESSIONS FIRST
        self.session_frames = []

        # Active sessions (clickable)
        for session in self.sessions:
            frame = self.create_session_card(
                scrollable_frame,
                session['user_id'],
                session['company_name'],
                session.get('login_method', 'unknown'),
                is_active=True
            )
            frame.pack(pady=8, fill=tk.X)
            self.session_frames.append(frame)

        # Inactive sessions (non-clickable, greyed out)
        for session in self.expired_sessions:
            frame = self.create_session_card(
                scrollable_frame,
                session['user_id'],
                session['company_name'],
                session.get('login_method', 'unknown'),
                is_active=False
            )
            frame.pack(pady=8, fill=tk.X)
            self.session_frames.append(frame)

        canvas.pack(side="left", fill="both", expand=True)

        # Enable mouse wheel scrolling
        def on_mousewheel(event):
            canvas.yview_scroll(int(-1*(event.delta/120)), "units")

        def bind_mousewheel(event):
            canvas.bind_all("<MouseWheel>", on_mousewheel)

        def unbind_mousewheel(event):
            canvas.unbind_all("<MouseWheel>")

        canvas.bind("<Enter>", bind_mousewheel)
        canvas.bind("<Leave>", unbind_mousewheel)

        # Buttons at bottom
        button_frame = tk.Frame(self.root, bg=self.bg_color)
        button_frame.pack(pady=(0, 20), padx=20, fill=tk.X)

        if self.show_action_buttons:
            # 3 Buttons: Exit | Refresh Sessions | Add New
            # Configure grid columns for equal spacing
            button_frame.grid_columnconfigure(0, weight=1, uniform="button")
            button_frame.grid_columnconfigure(1, weight=1, uniform="button")
            button_frame.grid_columnconfigure(2, weight=1, uniform="button")
        else:
            # Only 1 Button: Cancel
            button_frame.grid_columnconfigure(0, weight=1)

        # LEFT: Exit/Cancel button
        exit_btn = tk.Button(
            button_frame,
            text="Cancel" if not self.show_action_buttons else "Exit",
            command=self.cancel if not self.show_action_buttons else self.exit_app,
            font=("Segoe UI", 12, "bold"),
            bg="#ef4444",
            fg="white",
            activebackground="#dc2626",
            activeforeground="white",
            relief=tk.FLAT,
            cursor="hand2",
            pady=15,
            borderwidth=0,
            highlightthickness=0
        )
        if self.show_action_buttons:
            exit_btn.grid(row=0, column=0, sticky="ew", padx=(0, 5))
        else:
            exit_btn.grid(row=0, column=0, sticky="ew")

        # MIDDLE: Refresh Sessions button (only if action buttons enabled)
        if self.show_action_buttons:
            refresh_btn = tk.Button(
                button_frame,
                text="Refresh Sessions",
                command=self.refresh_sessions,
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
            refresh_btn.grid(row=0, column=1, sticky="ew", padx=5)

            def on_refresh_enter(e):
                refresh_btn.configure(bg="#2563eb")
            def on_refresh_leave(e):
                refresh_btn.configure(bg="#3b82f6")
            refresh_btn.bind('<Enter>', on_refresh_enter)
            refresh_btn.bind('<Leave>', on_refresh_leave)

        # RIGHT: Add New Session button (only if action buttons enabled)
        if self.show_action_buttons:
            new_session_btn = tk.Button(
                button_frame,
            text="Add New",
            command=self.add_new_session,
            font=("Segoe UI", 12, "bold"),
            bg="#10b981",
            fg="white",
            activebackground="#059669",
            activeforeground="white",
            relief=tk.FLAT,
            cursor="hand2",
            pady=15,
            borderwidth=0,
            highlightthickness=0
        )
            new_session_btn.grid(row=0, column=2, sticky="ew", padx=(5, 0))

            # Add hover effects for Add New button
            def on_new_enter(e):
                new_session_btn.configure(bg="#059669")
            def on_new_leave(e):
                new_session_btn.configure(bg="#10b981")
            new_session_btn.bind('<Enter>', on_new_enter)
            new_session_btn.bind('<Leave>', on_new_leave)

        # Add hover effects for Exit button
        def on_exit_enter(e):
            exit_btn.configure(bg="#dc2626")
        def on_exit_leave(e):
            exit_btn.configure(bg="#ef4444")
        exit_btn.bind('<Enter>', on_exit_enter)
        exit_btn.bind('<Leave>', on_exit_leave)

        # Keyboard shortcuts
        self.root.bind('<Escape>', lambda e: self.cancel())
        self.root.bind('<Control-c>', lambda e: self.cancel())
        for i in range(min(9, len(self.sessions))):
            self.root.bind(str(i + 1), lambda e, idx=i: self.select_session(self.sessions[idx]['user_id']))

    def create_session_card(self, parent, user_id, company_name, login_method, is_active=True):
        """Create a session selection card."""
        # Outer container for centering
        container = tk.Frame(parent, bg=self.bg_color)

        # Different styling for active vs inactive sessions
        card_bg = self.card_bg if is_active else "#0f172a"
        cursor = "hand2" if is_active else "arrow"

        frame = tk.Frame(
            container,
            bg=card_bg,
            highlightbackground="#3b82f6" if is_active else "#374151",
            highlightthickness=0,
            cursor=cursor
        )
        frame.pack(fill=tk.X, expand=True)

        # Add rounded corners effect with border
        frame.configure(relief=tk.FLAT, bd=0)

        frame.user_id = user_id
        frame.is_active = is_active
        container.user_id = user_id  # Store on container too for list management
        container.is_active = is_active

        # Click handler (only for active sessions)
        def click_handler(event):
            if is_active:
                self.select_session(user_id)

        if is_active:
            frame.bind('<Button-1>', click_handler)
            container.bind('<Button-1>', click_handler)

        # Content frame with grid layout (3 columns)
        content_frame = tk.Frame(frame, bg=card_bg, cursor=cursor)
        content_frame.pack(fill=tk.BOTH, padx=25, pady=18)
        if is_active:
            content_frame.bind('<Button-1>', click_handler)

        # Configure grid columns
        content_frame.grid_columnconfigure(0, weight=0, minsize=70)  # Icon column (fixed width, increased for larger icons)
        content_frame.grid_columnconfigure(1, weight=1)               # Company name column (expandable)
        content_frame.grid_columnconfigure(2, weight=0, minsize=100) # User ID column (fixed width)

        # COLUMN 1: Method icon (centered)
        icon_frame = tk.Frame(content_frame, bg=card_bg, cursor=cursor)
        icon_frame.grid(row=0, column=0, sticky="")
        if is_active:
            icon_frame.bind('<Button-1>', click_handler)

        if login_method == 'steam':
            # Steam icon (using emoji as placeholder)
            icon_label = tk.Label(
                icon_frame,
                text="🎮",
                font=("Segoe UI", 30),
                bg=card_bg,
                fg=self.fg_color if is_active else "#6b7280",
                cursor=cursor
            )
            icon_label.pack()
            if is_active:
                icon_label.bind('<Button-1>', click_handler)
        else:
            # Browser icon (default for everything that's not Steam, 1.5x larger)
            icon_label = tk.Label(
                icon_frame,
                text="🌐",
                font=("Segoe UI", 30),
                bg=card_bg,
                fg=self.fg_color if is_active else "#6b7280",
                cursor=cursor
            )
            icon_label.pack()
            if is_active:
                icon_label.bind('<Button-1>', click_handler)

        # COLUMN 2: Company name (centered)
        name_label = tk.Label(
            content_frame,
            text=company_name,
            font=("Segoe UI", 14, "bold"),
            bg=card_bg,
            fg=self.fg_color if is_active else "#6b7280",
            cursor=cursor
        )
        name_label.grid(row=0, column=1, sticky="")
        if is_active:
            name_label.bind('<Button-1>', click_handler)

        # COLUMN 3: User ID badge (centered)
        badge_bg = "#2563eb" if is_active else "#374151"
        badge_fg = "white" if is_active else "#9ca3af"
        id_label = tk.Label(
            content_frame,
            text=f"ID: {user_id}",
            font=("Segoe UI", 9, "bold"),
            bg=badge_bg,
            fg=badge_fg,
            padx=12,
            pady=6,
            cursor=cursor
        )
        id_label.grid(row=0, column=2, sticky="")
        if is_active:
            id_label.bind('<Button-1>', click_handler)

        # Hover effects with smooth transitions (only for active sessions)
        if is_active:
            def on_enter(e):
                if frame.user_id != self.selected_user_id.get():
                    hover_bg = "#2d3748"
                    frame.configure(bg=hover_bg, highlightbackground="#60a5fa", highlightthickness=2)
                    content_frame.configure(bg=hover_bg)
                    icon_frame.configure(bg=hover_bg)
                    name_label.configure(bg=hover_bg)
                    id_label.configure(bg="#2563eb")  # Keep badge color
                    # Update icon background
                    icon_label.configure(bg=hover_bg)

            def on_leave(e):
                if frame.user_id != self.selected_user_id.get():
                    frame.configure(bg=self.card_bg, highlightbackground="#3b82f6", highlightthickness=0)
                    content_frame.configure(bg=self.card_bg)
                    icon_frame.configure(bg=self.card_bg)
                    name_label.configure(bg=self.card_bg)
                    id_label.configure(bg="#2563eb")  # Keep badge color
                    # Update icon background
                    icon_label.configure(bg=self.card_bg)

            # Bind hover to all widgets
            hover_widgets = [container, frame, content_frame, icon_frame, name_label, id_label, icon_label]

            for widget in hover_widgets:
                widget.bind('<Enter>', on_enter)
                widget.bind('<Leave>', on_leave)

        # Store frame reference in container for highlight_selection
        container.frame = frame

        return container

    def select_session(self, user_id):
        """Select a session and close dialog."""
        print(f"[SessionSelector] User selected session: {user_id}", file=sys.stderr)
        self.selected_user_id.set(user_id)
        self.highlight_selection()

        # Close immediately after selection
        self.result = {"action": "use_session", "user_id": user_id}
        print(f"[SessionSelector] Result set to: {self.result}", file=sys.stderr)
        self.root.quit()
        self.root.destroy()

    def highlight_selection(self):
        """Highlight selected session."""
        selected = self.selected_user_id.get()
        for container in self.session_frames:
            frame = container.frame
            if container.user_id == selected:
                frame.configure(bg="#2563eb", highlightbackground="#3b82f6", highlightthickness=3)
            else:
                frame.configure(bg=self.card_bg, highlightbackground="#3b82f6", highlightthickness=0)

    def add_new_session(self):
        """User wants to add a new session."""
        self.result = {"action": "new_session"}
        self.root.quit()
        self.root.destroy()

    def exit_app(self):
        """Exit application completely."""
        self.result = None
        self.root.quit()
        self.root.destroy()
        sys.exit(0)

    def refresh_sessions(self):
        """Open refresh dialog to select expired sessions to renew."""
        self.result = {"action": "refresh_sessions"}
        self.root.quit()
        self.root.destroy()

    def cancel(self):
        """Cancel and exit."""
        print("[SessionSelector] User cancelled", file=sys.stderr)
        self.result = None
        print(f"[SessionSelector] Result set to None", file=sys.stderr)
        self.root.quit()
        self.root.destroy()

    def show(self):
        """Show dialog and return result."""
        print("[SessionSelector] Starting mainloop", file=sys.stderr)
        self.root.mainloop()
        print(f"[SessionSelector] Mainloop ended, returning result: {self.result}", file=sys.stderr)
        return self.result

if __name__ == "__main__":
    # Expect JSON input with session list (active) and optionally expired sessions
    if len(sys.argv) < 2:
        print("[-] ERROR: No session data provided", file=sys.stderr)
        sys.exit(1)

    try:
        sessions = json.loads(sys.argv[1])

        # Optional: expired sessions as second argument
        expired_sessions = []
        if len(sys.argv) >= 3:
            try:
                expired_sessions = json.loads(sys.argv[2])
            except:
                pass  # If parsing fails, just use empty list

        # Optional: show_action_buttons as third argument
        show_action_buttons = True
        if len(sys.argv) >= 4:
            show_action_buttons = sys.argv[3] == 'True'

        # Check if we have at least one session (active or expired)
        if (not sessions or len(sessions) == 0) and (not expired_sessions or len(expired_sessions) == 0):
            print("[-] ERROR: No sessions available (neither active nor expired)", file=sys.stderr)
            sys.exit(1)

        dialog = SessionSelectorDialog(sessions if sessions else [], expired_sessions, show_action_buttons)
        result = dialog.show()

        print(f"[SessionSelector __main__] Got result from show(): {result}", file=sys.stderr)

        if result:
            # Print result as JSON for Python to capture
            json_output = json.dumps(result)
            print(f"[SessionSelector __main__] Outputting JSON to stdout: {json_output}", file=sys.stderr)
            print(json_output)
            sys.exit(0)
        else:
            # User cancelled
            print("[SessionSelector __main__] No result, exiting with code 1", file=sys.stderr)
            sys.exit(1)

    except KeyboardInterrupt:
        # User pressed Ctrl+C - exit gracefully without error spam
        sys.exit(0)
    except Exception as e:
        print(f"[-] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
