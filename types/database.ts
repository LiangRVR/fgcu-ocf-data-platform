export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      advising_meeting: {
        Row: {
          advisor_id: number | null
          application_id: number | null
          created_at: string
          created_by_advisor_id: number | null
          meeting_date: string
          meeting_id: number
          meeting_mode: string
          no_show: boolean
          notes: string | null
          student_id: number
        }
        Insert: {
          advisor_id?: number | null
          application_id?: number | null
          created_at?: string
          created_by_advisor_id?: number | null
          meeting_date: string
          meeting_id?: number
          meeting_mode: string
          no_show?: boolean
          notes?: string | null
          student_id: number
        }
        Update: {
          advisor_id?: number | null
          application_id?: number | null
          created_at?: string
          created_by_advisor_id?: number | null
          meeting_date?: string
          meeting_id?: number
          meeting_mode?: string
          no_show?: boolean
          notes?: string | null
          student_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "advising_meeting_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "advising_meeting_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["application_id"]
          },
          {
            foreignKeyName: "advising_meeting_application_student_fkey"
            columns: ["application_id", "student_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["application_id", "student_id"]
          },
          {
            foreignKeyName: "advising_meeting_created_by_advisor_id_fkey"
            columns: ["created_by_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "advising_meeting_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
        ]
      }
      advising_meeting_amendment: {
        Row: {
          amendment_id: number
          created_at: string
          created_by_advisor_id: number
          details: string
          meeting_id: number
          reason: string
        }
        Insert: {
          amendment_id?: number
          created_at?: string
          created_by_advisor_id: number
          details: string
          meeting_id: number
          reason: string
        }
        Update: {
          amendment_id?: number
          created_at?: string
          created_by_advisor_id?: number
          details?: string
          meeting_id?: number
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "advising_meeting_amendment_created_by_advisor_id_fkey"
            columns: ["created_by_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "advising_meeting_amendment_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "advising_meeting"
            referencedColumns: ["meeting_id"]
          },
        ]
      }
      advisor: {
        Row: {
          advisor_id: number
          advisor_name: string
          auth_user_id: string | null
          created_at: string
          email: string | null
          is_active: boolean
          last_login_at: string | null
          role: string
        }
        Insert: {
          advisor_id?: number
          advisor_name: string
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          is_active?: boolean
          last_login_at?: string | null
          role?: string
        }
        Update: {
          advisor_id?: number
          advisor_name?: string
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          is_active?: boolean
          last_login_at?: string | null
          role?: string
        }
        Relationships: []
      }
      advisor_role_lock: {
        Row: {
          advisor_id: number
          created_at: string
          holder: string
          lease_expires_at: string
        }
        Insert: {
          advisor_id: number
          created_at?: string
          holder: string
          lease_expires_at: string
        }
        Update: {
          advisor_id?: number
          created_at?: string
          holder?: string
          lease_expires_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "advisor_role_lock_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: true
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
        ]
      }
      application: {
        Row: {
          application_id: number
          application_year: number | null
          destination_country: string | null
          fellowship_id: number
          is_finalist: boolean
          is_semi_finalist: boolean
          stage_of_application: string
          student_id: number
        }
        Insert: {
          application_id?: number
          application_year?: number | null
          destination_country?: string | null
          fellowship_id: number
          is_finalist?: boolean
          is_semi_finalist?: boolean
          stage_of_application: string
          student_id: number
        }
        Update: {
          application_id?: number
          application_year?: number | null
          destination_country?: string | null
          fellowship_id?: number
          is_finalist?: boolean
          is_semi_finalist?: boolean
          stage_of_application?: string
          student_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "application_fellowship_id_fkey"
            columns: ["fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "application_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
        ]
      }
      fellowship: {
        Row: {
          archived_at: string | null
          fellowship_id: number
          fellowship_name: string
        }
        Insert: {
          archived_at?: string | null
          fellowship_id?: number
          fellowship_name: string
        }
        Update: {
          archived_at?: string | null
          fellowship_id?: number
          fellowship_name?: string
        }
        Relationships: []
      }
      fellowship_thursday: {
        Row: {
          attendance_id: number
          attended: boolean
          source_info: string | null
          student_id: number
        }
        Insert: {
          attendance_id?: number
          attended: boolean
          source_info?: string | null
          student_id: number
        }
        Update: {
          attendance_id?: number
          attended?: boolean
          source_info?: string | null
          student_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
        ]
      }
      fellowship_thursday_amendment: {
        Row: {
          amendment_id: number
          attendance_id: number
          corrects_source_info: boolean
          corrected_attended: boolean | null
          corrected_source_info: string | null
          created_at: string
          created_by_advisor_id: number
          details: string | null
          reason: string
        }
        Insert: {
          amendment_id?: number
          attendance_id: number
          corrects_source_info?: boolean
          corrected_attended?: boolean | null
          corrected_source_info?: string | null
          created_at?: string
          created_by_advisor_id?: number
          details?: string | null
          reason: string
        }
        Update: {
          amendment_id?: number
          attendance_id?: number
          corrects_source_info?: boolean
          corrected_attended?: boolean | null
          corrected_source_info?: string | null
          created_at?: string
          created_by_advisor_id?: number
          details?: string | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "fellowship_thursday_amendment_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "fellowship_thursday"
            referencedColumns: ["attendance_id"]
          },
          {
            foreignKeyName: "fellowship_thursday_amendment_created_by_advisor_id_fkey"
            columns: ["created_by_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
        ]
      }
      scholarship_history: {
        Row: {
          fellowship_id: number
          history_id: number
          student_id: number
        }
        Insert: {
          fellowship_id: number
          history_id?: number
          student_id: number
        }
        Update: {
          fellowship_id?: number
          history_id?: number
          student_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
        ]
      }
      scholarship_history_amendment: {
        Row: {
          amendment_id: number
          amendment_type: string
          corrected_fellowship_id: number | null
          created_at: string
          created_by_advisor_id: number
          details: string | null
          history_id: number
          reason: string
        }
        Insert: {
          amendment_id?: number
          amendment_type: string
          corrected_fellowship_id?: number | null
          created_at?: string
          created_by_advisor_id?: number
          details?: string | null
          history_id: number
          reason: string
        }
        Update: {
          amendment_id?: number
          amendment_type?: string
          corrected_fellowship_id?: number | null
          created_at?: string
          created_by_advisor_id?: number
          details?: string | null
          history_id?: number
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "scholarship_history_amendment_corrected_fellowship_id_fkey"
            columns: ["corrected_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_amendment_created_by_advisor_id_fkey"
            columns: ["created_by_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "scholarship_history_amendment_history_id_fkey"
            columns: ["history_id"]
            isOneToOne: false
            referencedRelation: "scholarship_history"
            referencedColumns: ["history_id"]
          },
        ]
      }
      student: {
        Row: {
          age: number | null
          archived_at: string | null
          class_standing: string | null
          email: string
          first_gen: boolean
          full_name: string
          gender: string | null
          gpa: number | null
          honors_college: boolean
          is_ch_student: boolean
          languages: string | null
          major: string | null
          minor: string | null
          pronouns: string | null
          race_ethnicity: string | null
          student_id: number
          us_citizen: boolean
        }
        Insert: {
          age?: number | null
          archived_at?: string | null
          class_standing?: string | null
          email: string
          first_gen?: boolean
          full_name: string
          gender?: string | null
          gpa?: number | null
          honors_college?: boolean
          is_ch_student?: boolean
          languages?: string | null
          major?: string | null
          minor?: string | null
          pronouns?: string | null
          race_ethnicity?: string | null
          student_id?: number
          us_citizen: boolean
        }
        Update: {
          age?: number | null
          archived_at?: string | null
          class_standing?: string | null
          email?: string
          first_gen?: boolean
          full_name?: string
          gender?: string | null
          gpa?: number | null
          honors_college?: boolean
          is_ch_student?: boolean
          languages?: string | null
          major?: string | null
          minor?: string | null
          pronouns?: string | null
          race_ethnicity?: string | null
          student_id?: number
          us_citizen?: boolean
        }
        Relationships: []
      }
    }
    Views: {
      effective_fellowship_thursday: {
        Row: {
          attendance_id: number
          attended: boolean
          base_attended: boolean
          base_source_info: string | null
          has_amendments: boolean
          source_info: string | null
          student_id: number
        }
        Relationships: [
          {
            foreignKeyName: "never"
            columns: []
            isOneToOne: false
            referencedRelation: "fellowship_thursday"
            referencedColumns: ["attendance_id"]
          },
        ]
      }
      effective_scholarship_history: {
        Row: {
          base_fellowship_id: number
          fellowship_id: number
          has_correction: boolean
          history_id: number
          is_voided: boolean
          student_id: number
          void_amendment_id: number | null
          voided_at: string | null
          voided_by_advisor_id: number | null
        }
        Relationships: [
          {
            foreignKeyName: "never"
            columns: []
            isOneToOne: false
            referencedRelation: "scholarship_history"
            referencedColumns: ["history_id"]
          },
        ]
      }
    }
    Functions: {
      acquire_advisor_role_lock: {
        Args: {
          p_advisor_id: number
          p_holder: string
          p_lease_seconds: number
        }
        Returns: boolean
      }
      fenced_read_advisor_role_display: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: string
      }
      fenced_write_advisor_role_display: {
        Args: { p_advisor_id: number; p_holder: string; p_role: string }
        Returns: boolean
      }
      is_active_advisor: { Args: never; Returns: boolean }
      is_effective_admin: { Args: never; Returns: boolean }
      is_ocf_admin: { Args: never; Returns: boolean }
      lifecycle_transition: {
        Args: { p_action: string; p_entity: string; p_entity_id: number }
        Returns: {
          action: string
          applied: boolean
          archived_at: string
          entity: string
          entity_id: number
          is_active: boolean
        }[]
      }
      reconcile_advisor_role_display: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: string
      }
      release_advisor_role_lock: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: boolean
      }
      set_advisor_role: {
        Args: { p_advisor_id: number; p_role: string }
        Returns: {
          advisor_id: number
          auth_user_id: string
          role: string
        }[]
      }
      verify_advisor_role_lock: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
