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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      api_tokens: {
        Row: {
          created_at: string
          id: string
          label: string
          last_used_at: string | null
          revoked: boolean
          tenant_id: string
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
          tenant_id: string
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
          tenant_id?: string
          token_hash?: string
          token_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          attempts: number
          cashier_id: string | null
          created_at: string
          customer_tin: string | null
          erp_invoice_number: string
          erp_payload: Json
          grand_total: number
          id: string
          idempotency_key: string | null
          invoice_sequence: number | null
          is_offline: boolean
          last_error: string | null
          mra_invoice_id: string | null
          mra_invoice_number: string | null
          mra_payload: Json | null
          mra_response: Json | null
          offline_signature: string | null
          qr_payload: string | null
          signature: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          terminal_uid: string | null
          total_vat: number
          transaction_count: number | null
          updated_at: string
          validation_url: string | null
        }
        Insert: {
          attempts?: number
          cashier_id?: string | null
          created_at?: string
          customer_tin?: string | null
          erp_invoice_number: string
          erp_payload: Json
          grand_total?: number
          id?: string
          idempotency_key?: string | null
          invoice_sequence?: number | null
          is_offline?: boolean
          last_error?: string | null
          mra_invoice_id?: string | null
          mra_invoice_number?: string | null
          mra_payload?: Json | null
          mra_response?: Json | null
          offline_signature?: string | null
          qr_payload?: string | null
          signature?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          terminal_uid?: string | null
          total_vat?: number
          transaction_count?: number | null
          updated_at?: string
          validation_url?: string | null
        }
        Update: {
          attempts?: number
          cashier_id?: string | null
          created_at?: string
          customer_tin?: string | null
          erp_invoice_number?: string
          erp_payload?: Json
          grand_total?: number
          id?: string
          idempotency_key?: string | null
          invoice_sequence?: number | null
          is_offline?: boolean
          last_error?: string | null
          mra_invoice_id?: string | null
          mra_invoice_number?: string | null
          mra_payload?: Json | null
          mra_response?: Json | null
          offline_signature?: string | null
          qr_payload?: string | null
          signature?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          terminal_uid?: string | null
          total_vat?: number
          transaction_count?: number | null
          updated_at?: string
          validation_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_terminal_uid_fkey"
            columns: ["terminal_uid"]
            isOneToOne: false
            referencedRelation: "terminals"
            referencedColumns: ["id"]
          },
        ]
      }
      mra_logs: {
        Row: {
          created_at: string
          duration_ms: number | null
          endpoint: string
          id: number
          ok: boolean
          request_body: string | null
          response_body: string | null
          status_code: number | null
          tenant_id: string | null
          terminal_uid: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          endpoint: string
          id?: number
          ok?: boolean
          request_body?: string | null
          response_body?: string | null
          status_code?: number | null
          tenant_id?: string | null
          terminal_uid?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          endpoint?: string
          id?: number
          ok?: boolean
          request_body?: string | null
          response_body?: string | null
          status_code?: number | null
          tenant_id?: string | null
          terminal_uid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mra_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_maps: {
        Row: {
          auto_registered: boolean
          created_at: string
          description: string | null
          id: string
          informal_purchase: boolean
          local_sku: string
          mra_product_id: string | null
          product_type: string
          quantity_on_hand: number | null
          tax_category: string
          tax_rate_id: string | null
          tenant_id: string
          unit_of_measure: string | null
          updated_at: string
        }
        Insert: {
          auto_registered?: boolean
          created_at?: string
          description?: string | null
          id?: string
          informal_purchase?: boolean
          local_sku: string
          mra_product_id?: string | null
          product_type?: string
          quantity_on_hand?: number | null
          tax_category?: string
          tax_rate_id?: string | null
          tenant_id: string
          unit_of_measure?: string | null
          updated_at?: string
        }
        Update: {
          auto_registered?: boolean
          created_at?: string
          description?: string | null
          id?: string
          informal_purchase?: boolean
          local_sku?: string
          mra_product_id?: string | null
          product_type?: string
          quantity_on_hand?: number | null
          tax_category?: string
          tax_rate_id?: string | null
          tenant_id?: string
          unit_of_measure?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_maps_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_buckets: {
        Row: {
          tenant_id: string
          tokens: number
          updated_at: string
        }
        Insert: {
          tenant_id: string
          tokens?: number
          updated_at?: string
        }
        Update: {
          tenant_id?: string
          tokens?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_limit_buckets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          address: string | null
          code: string
          created_at: string
          id: string
          is_active: boolean
          mra_site_id: string | null
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          mra_site_id?: string | null
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          mra_site_id?: string | null
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_queue: {
        Row: {
          attempts: number
          created_at: string
          id: number
          invoice_id: string
          last_error: string | null
          locked_at: string | null
          run_after: string
          status: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: number
          invoice_id: string
          last_error?: string | null
          locked_at?: string | null
          run_after?: string
          status?: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: number
          invoice_id?: string
          last_error?: string | null
          locked_at?: string | null
          run_after?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_queue_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          mode: string
          name: string
          owner_user_id: string
          rate_limit_per_min: number
          slug: string
          taxpayer_tin: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          mode?: string
          name: string
          owner_user_id: string
          rate_limit_per_min?: number
          slug: string
          taxpayer_tin?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          mode?: string
          name?: string
          owner_user_id?: string
          rate_limit_per_min?: number
          slug?: string
          taxpayer_tin?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      terminal_secrets: {
        Row: {
          access_key_enc: string
          secret_key_enc: string
          session_expires_at: string | null
          session_token_enc: string | null
          tenant_id: string
          terminal_uid: string
          updated_at: string
        }
        Insert: {
          access_key_enc: string
          secret_key_enc: string
          session_expires_at?: string | null
          session_token_enc?: string | null
          tenant_id: string
          terminal_uid: string
          updated_at?: string
        }
        Update: {
          access_key_enc?: string
          secret_key_enc?: string
          session_expires_at?: string | null
          session_token_enc?: string | null
          tenant_id?: string
          terminal_uid?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "terminal_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "terminal_secrets_terminal_uid_fkey"
            columns: ["terminal_uid"]
            isOneToOne: true
            referencedRelation: "terminals"
            referencedColumns: ["id"]
          },
        ]
      }
      terminals: {
        Row: {
          activated_at: string | null
          activation_code: string | null
          blocking_message: string | null
          config: Json
          confirmed_at: string | null
          created_at: string
          global_config_version: number
          id: string
          invoice_sequence: number
          is_blocked: boolean
          last_config_sync_at: string | null
          last_error: string | null
          mra_terminal_ref: string | null
          offline_accumulated: number
          offline_max_age_hours: number
          offline_max_amount: number
          status: string
          store_id: string
          store_uid: string | null
          taxpayer_config_version: number
          taxpayer_id: number | null
          tenant_id: string
          terminal_config_version: number
          terminal_id: string
          terminal_position: number | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          activation_code?: string | null
          blocking_message?: string | null
          config?: Json
          confirmed_at?: string | null
          created_at?: string
          global_config_version?: number
          id?: string
          invoice_sequence?: number
          is_blocked?: boolean
          last_config_sync_at?: string | null
          last_error?: string | null
          mra_terminal_ref?: string | null
          offline_accumulated?: number
          offline_max_age_hours?: number
          offline_max_amount?: number
          status?: string
          store_id: string
          store_uid?: string | null
          taxpayer_config_version?: number
          taxpayer_id?: number | null
          tenant_id: string
          terminal_config_version?: number
          terminal_id: string
          terminal_position?: number | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          activation_code?: string | null
          blocking_message?: string | null
          config?: Json
          confirmed_at?: string | null
          created_at?: string
          global_config_version?: number
          id?: string
          invoice_sequence?: number
          is_blocked?: boolean
          last_config_sync_at?: string | null
          last_error?: string | null
          mra_terminal_ref?: string | null
          offline_accumulated?: number
          offline_max_age_hours?: number
          offline_max_amount?: number
          status?: string
          store_id?: string
          store_uid?: string | null
          taxpayer_config_version?: number
          taxpayer_id?: number | null
          tenant_id?: string
          terminal_config_version?: number
          terminal_id?: string
          terminal_position?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "terminals_store_uid_fkey"
            columns: ["store_uid"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "terminals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_sync_jobs: {
        Args: { _limit: number }
        Returns: {
          attempts: number
          created_at: string
          id: number
          invoice_id: string
          last_error: string | null
          locked_at: string | null
          run_after: string
          status: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "sync_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      consume_rate_token: {
        Args: { _capacity: number; _refill_per_sec: number; _tenant_id: string }
        Returns: boolean
      }
      next_invoice_sequence: {
        Args: { _terminal_uid: string }
        Returns: number
      }
      owns_tenant: { Args: { _tenant_id: string }; Returns: boolean }
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
