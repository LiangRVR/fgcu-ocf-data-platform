export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      advising_meeting: {
        Row: {
          advisor_id: number | null
          meeting_date: string
          meeting_id: number
          meeting_mode: string
          no_show: boolean
          notes: string | null
          student_id: number
        }
        Insert: {
          advisor_id?: number | null
          meeting_date: string
          meeting_id?: number
          meeting_mode: string
          no_show?: boolean
          notes?: string | null
          student_id: number
        }
        Update: {
          advisor_id?: number | null
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
            foreignKeyName: "advising_meeting_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
        ]
      }
      advisor: {
        Row: {
          advisor_id: number
          advisor_name: string
        }
        Insert: {
          advisor_id?: number
          advisor_name: string
        }
        Update: {
          advisor_id?: number
          advisor_name?: string
        }
        Relationships: []
      }
      application: {
        Row: {
          application_id: number
          destination_country: string | null
          fellowship_id: number
          is_finalist: boolean
          is_semi_finalist: boolean
          stage_of_application: string
          student_id: number
        }
        Insert: {
          application_id?: number
          destination_country?: string | null
          fellowship_id: number
          is_finalist?: boolean
          is_semi_finalist?: boolean
          stage_of_application: string
          student_id: number
        }
        Update: {
          application_id?: number
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
          fellowship_id: number
          fellowship_name: string
        }
        Insert: {
          fellowship_id?: number
          fellowship_name: string
        }
        Update: {
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
      student: {
        Row: {
          age: number | null
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
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
