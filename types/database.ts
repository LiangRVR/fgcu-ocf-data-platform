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
            foreignKeyName: "advising_meeting_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_list"
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
            foreignKeyName: "advising_meeting_application_student_fkey"
            columns: ["application_id", "student_id"]
            isOneToOne: false
            referencedRelation: "application_list"
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
          {
            foreignKeyName: "advising_meeting_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
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
          {
            foreignKeyName: "advising_meeting_amendment_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "advising_meeting_list"
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
          row_version: number
          updated_at: string
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
          row_version?: number
          updated_at?: string
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
          row_version?: number
          updated_at?: string
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
          row_version: number
          stage_of_application: string
          student_id: number
          updated_at: string
        }
        Insert: {
          application_id?: number
          application_year?: number | null
          destination_country?: string | null
          fellowship_id: number
          is_finalist?: boolean
          is_semi_finalist?: boolean
          row_version?: number
          stage_of_application: string
          student_id: number
          updated_at?: string
        }
        Update: {
          application_id?: number
          application_year?: number | null
          destination_country?: string | null
          fellowship_id?: number
          is_finalist?: boolean
          is_semi_finalist?: boolean
          row_version?: number
          stage_of_application?: string
          student_id?: number
          updated_at?: string
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
            foreignKeyName: "application_fellowship_id_fkey"
            columns: ["fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "application_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "application_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      audit_event: {
        Row: {
          action: string
          actor_advisor_id: number | null
          actor_name_snapshot: string
          audit_id: number
          changes: Json | null
          entity_id: number
          entity_type: string
          new_values: Json | null
          occurred_at: string
          old_values: Json | null
          origin: string
          reason: string | null
          subject_application_id: number | null
          subject_fellowship_id: number | null
          subject_student_id: number | null
        }
        Insert: {
          action: string
          actor_advisor_id?: number | null
          actor_name_snapshot: string
          audit_id?: number
          changes?: Json | null
          entity_id: number
          entity_type: string
          new_values?: Json | null
          occurred_at?: string
          old_values?: Json | null
          origin: string
          reason?: string | null
          subject_application_id?: number | null
          subject_fellowship_id?: number | null
          subject_student_id?: number | null
        }
        Update: {
          action?: string
          actor_advisor_id?: number | null
          actor_name_snapshot?: string
          audit_id?: number
          changes?: Json | null
          entity_id?: number
          entity_type?: string
          new_values?: Json | null
          occurred_at?: string
          old_values?: Json | null
          origin?: string
          reason?: string | null
          subject_application_id?: number | null
          subject_fellowship_id?: number | null
          subject_student_id?: number | null
        }
        Relationships: []
      }
      audit_event_subject: {
        Row: {
          audit_id: number
          relationship: string
          subject_id: number
          subject_name_snapshot: string | null
          subject_type: string
        }
        Insert: {
          audit_id: number
          relationship: string
          subject_id: number
          subject_name_snapshot?: string | null
          subject_type: string
        }
        Update: {
          audit_id?: number
          relationship?: string
          subject_id?: number
          subject_name_snapshot?: string | null
          subject_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_event_subject_audit_id_fkey"
            columns: ["audit_id"]
            isOneToOne: false
            referencedRelation: "audit_activity"
            referencedColumns: ["audit_id"]
          },
          {
            foreignKeyName: "audit_event_subject_audit_id_fkey"
            columns: ["audit_id"]
            isOneToOne: false
            referencedRelation: "audit_event"
            referencedColumns: ["audit_id"]
          },
        ]
      }
      fellowship: {
        Row: {
          archived_at: string | null
          fellowship_id: number
          fellowship_name: string
          row_version: number
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          fellowship_id?: number
          fellowship_name: string
          row_version?: number
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          fellowship_id?: number
          fellowship_name?: string
          row_version?: number
          updated_at?: string
        }
        Relationships: []
      }
      fellowship_thursday: {
        Row: {
          attendance_id: number
          attended: boolean
          event_date: string | null
          source_info: string | null
          student_id: number
        }
        Insert: {
          attendance_id?: number
          attended: boolean
          event_date?: string | null
          source_info?: string | null
          student_id: number
        }
        Update: {
          attendance_id?: number
          attended?: boolean
          event_date?: string | null
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
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      fellowship_thursday_amendment: {
        Row: {
          amendment_id: number
          attendance_id: number
          corrected_attended: boolean | null
          corrected_source_info: string | null
          corrects_source_info: boolean
          created_at: string
          created_by_advisor_id: number
          details: string | null
          reason: string
        }
        Insert: {
          amendment_id?: number
          attendance_id: number
          corrected_attended?: boolean | null
          corrected_source_info?: string | null
          corrects_source_info?: boolean
          created_at?: string
          created_by_advisor_id: number
          details?: string | null
          reason: string
        }
        Update: {
          amendment_id?: number
          attendance_id?: number
          corrected_attended?: boolean | null
          corrected_source_info?: string | null
          corrects_source_info?: boolean
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
            referencedRelation: "effective_fellowship_thursday"
            referencedColumns: ["attendance_id"]
          },
          {
            foreignKeyName: "fellowship_thursday_amendment_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "fellowship_thursday"
            referencedColumns: ["attendance_id"]
          },
          {
            foreignKeyName: "fellowship_thursday_amendment_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "fellowship_thursday_list"
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
          award_year: number | null
          fellowship_id: number
          history_id: number
          student_id: number
        }
        Insert: {
          award_year?: number | null
          fellowship_id: number
          history_id?: number
          student_id: number
        }
        Update: {
          award_year?: number | null
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
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
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
          created_by_advisor_id: number
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
            foreignKeyName: "scholarship_history_amendment_corrected_fellowship_id_fkey"
            columns: ["corrected_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
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
            referencedRelation: "effective_scholarship_history"
            referencedColumns: ["history_id"]
          },
          {
            foreignKeyName: "scholarship_history_amendment_history_id_fkey"
            columns: ["history_id"]
            isOneToOne: false
            referencedRelation: "scholarship_history"
            referencedColumns: ["history_id"]
          },
          {
            foreignKeyName: "scholarship_history_amendment_history_id_fkey"
            columns: ["history_id"]
            isOneToOne: false
            referencedRelation: "scholarship_history_list"
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
          row_version: number
          student_id: number
          updated_at: string
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
          row_version?: number
          student_id?: number
          updated_at?: string
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
          row_version?: number
          student_id?: number
          updated_at?: string
          us_citizen?: boolean
        }
        Relationships: []
      }
    }
    Views: {
      advising_meeting_list: {
        Row: {
          advisor_id: number | null
          advisor_name: string | null
          application_id: number | null
          application_year: number | null
          created_at: string | null
          created_by_advisor_id: number | null
          fellowship_id: number | null
          fellowship_name: string | null
          meeting_date: string | null
          meeting_id: number | null
          meeting_mode: string | null
          no_show: boolean | null
          notes: string | null
          recorded_by_advisor_name: string | null
          student_id: number | null
          student_name: string | null
        }
        Insert: {
          advisor_id?: number | null
          advisor_name?: never
          application_id?: number | null
          application_year?: never
          created_at?: string | null
          created_by_advisor_id?: number | null
          fellowship_id?: never
          fellowship_name?: never
          meeting_date?: string | null
          meeting_id?: number | null
          meeting_mode?: string | null
          no_show?: boolean | null
          notes?: string | null
          recorded_by_advisor_name?: never
          student_id?: number | null
          student_name?: never
        }
        Update: {
          advisor_id?: number | null
          advisor_name?: never
          application_id?: number | null
          application_year?: never
          created_at?: string | null
          created_by_advisor_id?: number | null
          fellowship_id?: never
          fellowship_name?: never
          meeting_date?: string | null
          meeting_id?: number | null
          meeting_mode?: string | null
          no_show?: boolean | null
          notes?: string | null
          recorded_by_advisor_name?: never
          student_id?: number | null
          student_name?: never
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
            foreignKeyName: "advising_meeting_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_list"
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
            foreignKeyName: "advising_meeting_application_student_fkey"
            columns: ["application_id", "student_id"]
            isOneToOne: false
            referencedRelation: "application_list"
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
          {
            foreignKeyName: "advising_meeting_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      application_list: {
        Row: {
          application_id: number | null
          application_year: number | null
          destination_country: string | null
          fellowship_id: number | null
          fellowship_name: string | null
          is_finalist: boolean | null
          is_semi_finalist: boolean | null
          stage_of_application: string | null
          student_id: number | null
          student_name: string | null
        }
        Insert: {
          application_id?: number | null
          application_year?: number | null
          destination_country?: string | null
          fellowship_id?: number | null
          fellowship_name?: never
          is_finalist?: boolean | null
          is_semi_finalist?: boolean | null
          stage_of_application?: string | null
          student_id?: number | null
          student_name?: never
        }
        Update: {
          application_id?: number | null
          application_year?: number | null
          destination_country?: string | null
          fellowship_id?: number | null
          fellowship_name?: never
          is_finalist?: boolean | null
          is_semi_finalist?: boolean | null
          stage_of_application?: string | null
          student_id?: number | null
          student_name?: never
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
            foreignKeyName: "application_fellowship_id_fkey"
            columns: ["fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "application_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "application_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      audit_activity: {
        Row: {
          action: string | null
          actor_advisor_id: number | null
          actor_name_snapshot: string | null
          advising_advisor_id: number | null
          advising_application_id: number | null
          advising_meeting_date: string | null
          audit_id: number | null
          current_fellowship_id: number | null
          current_fellowship_name: string | null
          current_student_id: number | null
          current_student_name: string | null
          entity_id: number | null
          entity_type: string | null
          fellowship_name: string | null
          fellowship_subject_ids: number[] | null
          fellowship_thursday_attended_after: boolean | null
          fellowship_thursday_attended_amended: boolean | null
          fellowship_thursday_attended_before: boolean | null
          fellowship_thursday_source_after: string | null
          fellowship_thursday_source_amended: boolean | null
          fellowship_thursday_source_before: string | null
          occurred_at: string | null
          origin: string | null
          previous_fellowship_id: number | null
          previous_fellowship_name: string | null
          previous_student_id: number | null
          previous_student_name: string | null
          reason: string | null
          student_name: string | null
          student_subject_ids: number[] | null
          subject_application_id: number | null
          subject_application_name: string | null
          subject_fellowship_id: number | null
          subject_student_id: number | null
          void_reason: string | null
        }
        Relationships: [
          {
            foreignKeyName: "advising_meeting_advisor_id_fkey"
            columns: ["advising_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "advising_meeting_application_id_fkey"
            columns: ["advising_application_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["application_id"]
          },
          {
            foreignKeyName: "advising_meeting_application_id_fkey"
            columns: ["advising_application_id"]
            isOneToOne: false
            referencedRelation: "application_list"
            referencedColumns: ["application_id"]
          },
        ]
      }
      effective_fellowship_thursday: {
        Row: {
          attendance_id: number | null
          attended: boolean | null
          base_attended: boolean | null
          base_source_info: string | null
          event_date: string | null
          has_amendments: boolean | null
          source_info: string | null
          student_id: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      effective_scholarship_history: {
        Row: {
          award_year: number | null
          base_fellowship_id: number | null
          fellowship_id: number | null
          has_correction: boolean | null
          history_id: number | null
          is_voided: boolean | null
          student_id: number | null
          void_amendment_id: number | null
          voided_at: string | null
          voided_by_advisor_id: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scholarship_history_amendment_created_by_advisor_id_fkey"
            columns: ["voided_by_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisor"
            referencedColumns: ["advisor_id"]
          },
          {
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["base_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["base_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      fellowship_list: {
        Row: {
          archived_at: string | null
          awarded_students: number | null
          fellowship_id: number | null
          fellowship_name: string | null
          finalists: number | null
          has_applications: boolean | null
          total_applications: number | null
        }
        Insert: {
          archived_at?: string | null
          awarded_students?: never
          fellowship_id?: number | null
          fellowship_name?: string | null
          finalists?: never
          has_applications?: never
          total_applications?: never
        }
        Update: {
          archived_at?: string | null
          awarded_students?: never
          fellowship_id?: number | null
          fellowship_name?: string | null
          finalists?: never
          has_applications?: never
          total_applications?: never
        }
        Relationships: []
      }
      fellowship_thursday_list: {
        Row: {
          attendance_id: number | null
          attended: boolean | null
          base_attended: boolean | null
          base_source_info: string | null
          event_date: string | null
          has_amendments: boolean | null
          source_info: string | null
          student_id: number | null
          student_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "fellowship_thursday_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      scholarship_history_list: {
        Row: {
          award_year: number | null
          base_fellowship_id: number | null
          fellowship_id: number | null
          fellowship_name: string | null
          has_correction: boolean | null
          history_id: number | null
          is_voided: boolean | null
          student_id: number | null
          student_name: string | null
          voided_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["base_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_fellowship_id_fkey"
            columns: ["base_fellowship_id"]
            isOneToOne: false
            referencedRelation: "fellowship_list"
            referencedColumns: ["fellowship_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student"
            referencedColumns: ["student_id"]
          },
          {
            foreignKeyName: "scholarship_history_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "student_list"
            referencedColumns: ["student_id"]
          },
        ]
      }
      student_list: {
        Row: {
          age: number | null
          archived_at: string | null
          class_standing: string | null
          email: string | null
          first_gen: boolean | null
          full_name: string | null
          gender: string | null
          gpa: number | null
          has_advising: boolean | null
          has_application: boolean | null
          has_prior_award: boolean | null
          honors_college: boolean | null
          is_ch_student: boolean | null
          languages: string | null
          major: string | null
          minor: string | null
          pronouns: string | null
          race_ethnicity: string | null
          student_id: number | null
          us_citizen: boolean | null
        }
        Insert: {
          age?: number | null
          archived_at?: string | null
          class_standing?: string | null
          email?: string | null
          first_gen?: boolean | null
          full_name?: string | null
          gender?: string | null
          gpa?: number | null
          has_advising?: never
          has_application?: never
          has_prior_award?: never
          honors_college?: boolean | null
          is_ch_student?: boolean | null
          languages?: string | null
          major?: string | null
          minor?: string | null
          pronouns?: string | null
          race_ethnicity?: string | null
          student_id?: number | null
          us_citizen?: boolean | null
        }
        Update: {
          age?: number | null
          archived_at?: string | null
          class_standing?: string | null
          email?: string | null
          first_gen?: boolean | null
          full_name?: string | null
          gender?: string | null
          gpa?: number | null
          has_advising?: never
          has_application?: never
          has_prior_award?: never
          honors_college?: boolean | null
          is_ch_student?: boolean | null
          languages?: string | null
          major?: string | null
          minor?: string | null
          pronouns?: string | null
          race_ethnicity?: string | null
          student_id?: number | null
          us_citizen?: boolean | null
        }
        Relationships: []
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
      begin_legacy_baseline_import: { Args: never; Returns: undefined }
      fenced_read_advisor_role_display: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: string
      }
      is_active_advisor: { Args: never; Returns: boolean }
      is_effective_admin: { Args: never; Returns: boolean }
      is_ocf_admin: { Args: never; Returns: boolean }
      lifecycle_transition: {
        Args: {
          p_action: string
          p_entity: string
          p_entity_id: number
          p_expected_version: number
          p_reason: string
        }
        Returns: {
          action: string
          applied: boolean
          archived_at: string
          entity: string
          entity_id: number
          is_active: boolean
          row_version: number
        }[]
      }
      provision_advisor: {
        Args: {
          p_actor_id: number
          p_advisor_name: string
          p_auth_user_id: string
          p_email: string
          p_role: string
        }
        Returns: {
          advisor_id: number
          auth_user_id: string
          role: string
          row_version: number
        }[]
      }
      release_advisor_role_lock: {
        Args: { p_advisor_id: number; p_holder: string }
        Returns: boolean
      }
      scholarship_history_operational_summary: {
        Args: { p_fellowship_id?: number; p_search?: string }
        Returns: {
          distinct_students: number
          total_records: number
        }[]
      }
      set_advisor_role: {
        Args: {
          p_actor_id: number
          p_advisor_id: number
          p_expected_version: number
          p_reason: string
          p_role: string
        }
        Returns: {
          advisor_id: number
          auth_user_id: string
          role: string
          row_version: number
        }[]
      }
      update_advisor_profile_name: {
        Args: {
          p_advisor_id: number
          p_advisor_name: string
          p_expected_version: number
        }
        Returns: {
          advisor_id: number
          advisor_name: string
          row_version: number
          updated_at: string
        }[]
      }
      update_application: {
        Args: {
          p_application_id: number
          p_application_year: number
          p_destination_country: string
          p_expected_version: number
          p_fellowship_id: number
          p_is_finalist: boolean
          p_is_semi_finalist: boolean
          p_stage_of_application: string
          p_student_id: number
        }
        Returns: {
          application_id: number
          application_year: number
          destination_country: string
          fellowship_id: number
          is_finalist: boolean
          is_semi_finalist: boolean
          row_version: number
          stage_of_application: string
          student_id: number
          updated_at: string
        }[]
      }
      update_fellowship: {
        Args: {
          p_expected_version: number
          p_fellowship_id: number
          p_fellowship_name: string
        }
        Returns: {
          archived_at: string
          fellowship_id: number
          fellowship_name: string
          row_version: number
          updated_at: string
        }[]
      }
      update_my_advisor_profile: {
        Args: { p_advisor_name: string; p_expected_version: number }
        Returns: {
          advisor_id: number
          advisor_name: string
          row_version: number
          updated_at: string
        }[]
      }
      update_student_profile: {
        Args: {
          p_age: number
          p_class_standing: string
          p_email: string
          p_expected_version: number
          p_first_gen: boolean
          p_full_name: string
          p_gender: string
          p_gpa: number
          p_honors_college: boolean
          p_is_ch_student: boolean
          p_languages: string
          p_major: string
          p_minor: string
          p_pronouns: string
          p_race_ethnicity: string
          p_student_id: number
          p_us_citizen: boolean
        }
        Returns: {
          age: number
          archived_at: string
          class_standing: string
          email: string
          first_gen: boolean
          full_name: string
          gender: string
          gpa: number
          honors_college: boolean
          is_ch_student: boolean
          languages: string
          major: string
          minor: string
          pronouns: string
          race_ethnicity: string
          row_version: number
          student_id: number
          updated_at: string
          us_citizen: boolean
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

