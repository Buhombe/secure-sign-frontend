--
-- PostgreSQL database dump
--

\restrict ggMcybZilixviIHqfqo0CCeKNUaqa0WjUhbroc7kgx9ZSTJNVIqyJ9phOYaHIAK

-- Dumped from database version 18.3 (Debian 18.3-1.pgdg13+1)
-- Dumped by pg_dump version 18.3 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit_logs_immutable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.audit_logs_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only. UPDATE and DELETE are not permitted.';
END;
$$;


ALTER FUNCTION public.audit_logs_immutable() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admin_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    resource_type character varying(50),
    resource_id character varying(255),
    details jsonb,
    ip_address character varying(45),
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.admin_logs OWNER TO postgres;

--
-- Name: admin_roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admin_roles (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.admin_roles OWNER TO postgres;

--
-- Name: admin_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.admin_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.admin_roles_id_seq OWNER TO postgres;

--
-- Name: admin_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.admin_roles_id_seq OWNED BY public.admin_roles.id;


--
-- Name: admins; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(254) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    last_login_ip character varying(45),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.admins OWNER TO postgres;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    document_id uuid,
    action character varying(100) NOT NULL,
    device_info text,
    ip_address character varying(45),
    "timestamp" timestamp with time zone DEFAULT now(),
    metadata jsonb,
    row_hmac character varying(64)
);


ALTER TABLE public.audit_logs OWNER TO postgres;

--
-- Name: document_signers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.document_signers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    email character varying(254) NOT NULL,
    order_num integer NOT NULL,
    token character varying(64),
    token_expires_at timestamp with time zone,
    token_used boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT document_signers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'signed'::character varying])::text[])))
);


ALTER TABLE public.document_signers OWNER TO postgres;

--
-- Name: documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    original_name character varying(255) NOT NULL,
    file_path character varying(500) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    recipient_email character varying(254),
    recipient_token character varying(64),
    created_at timestamp with time zone DEFAULT now(),
    recipient_token_expires_at timestamp with time zone,
    recipient_token_used boolean DEFAULT false NOT NULL,
    orig_file_path character varying(500),
    is_deleted boolean DEFAULT false NOT NULL,
    file_hash character varying(64),
    signed_at timestamp with time zone,
    signed_by character varying(254),
    cloudinary_public_id text,
    orig_cloudinary_public_id text,
    current_signer_order integer DEFAULT 1,
    total_signers integer DEFAULT 1,
    signing_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT documents_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'signed'::character varying, 'revoked'::character varying])::text[])))
);


ALTER TABLE public.documents OWNER TO postgres;

--
-- Name: plans; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plans (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    price_usd numeric(10,2) DEFAULT 0 NOT NULL,
    max_docs_month integer DEFAULT 5 NOT NULL,
    max_signers integer DEFAULT 1 NOT NULL,
    max_storage_mb integer DEFAULT 100 NOT NULL,
    can_audit_log boolean DEFAULT false NOT NULL,
    can_bulk_send boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.plans OWNER TO postgres;

--
-- Name: plans_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.plans_id_seq OWNER TO postgres;

--
-- Name: plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plans_id_seq OWNED BY public.plans.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.refresh_tokens OWNER TO postgres;

--
-- Name: signatures; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    user_id uuid,
    signer_email character varying(254),
    signature_hash character varying(64) NOT NULL,
    sig_x double precision DEFAULT 0,
    sig_y double precision DEFAULT 0,
    sig_width double precision DEFAULT 200,
    sig_height double precision DEFAULT 80,
    page_number integer DEFAULT 1,
    verified boolean DEFAULT false,
    verification_method character varying(100),
    signed_at timestamp with time zone DEFAULT now(),
    crypto_signature text,
    document_hash character varying(64)
);


ALTER TABLE public.signatures OWNER TO postgres;

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_id integer NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    current_period_start timestamp with time zone DEFAULT now() NOT NULL,
    current_period_end timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    payment_ref character varying(255),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.subscriptions OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(254) NOT NULL,
    password_hash character varying(255) NOT NULL,
    profile_photo text,
    created_at timestamp with time zone DEFAULT now(),
    is_suspended boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    suspended_at timestamp with time zone,
    suspend_reason text,
    is_deleted boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret text,
    mfa_secret_pending text,
    failed_attempts integer DEFAULT 0 NOT NULL,
    lockout_until timestamp with time zone,
    email_verified boolean DEFAULT false NOT NULL,
    email_verification_token character varying(64),
    email_verification_sent_at timestamp with time zone,
    password_reset_token character varying(64),
    password_reset_expires_at timestamp with time zone,
    public_key text,
    private_key_enc text
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: admin_roles id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_roles ALTER COLUMN id SET DEFAULT nextval('public.admin_roles_id_seq'::regclass);


--
-- Name: plans id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plans ALTER COLUMN id SET DEFAULT nextval('public.plans_id_seq'::regclass);


--
-- Data for Name: admin_logs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.admin_logs (id, admin_id, action, resource_type, resource_id, details, ip_address, user_agent, created_at) FROM stdin;
\.


--
-- Data for Name: admin_roles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.admin_roles (id, name, permissions, created_at) FROM stdin;
1	super_admin	["*"]	2026-04-16 12:55:59.310488+00
2	support_admin	["users.read", "users.suspend", "documents.read", "stats.read", "logs.read"]	2026-04-16 12:55:59.310488+00
3	read_only	["users.read", "documents.read", "stats.read"]	2026-04-16 12:55:59.310488+00
\.


--
-- Data for Name: admins; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.admins (id, email, password_hash, role_id, is_active, last_login_at, last_login_ip, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.audit_logs (id, user_id, document_id, action, device_info, ip_address, "timestamp", metadata, row_hmac) FROM stdin;
ee33480f-fa1b-4450-9b6f-a8b430d2f087	df58c25f-3c67-4d3b-b53b-75d6c18a49ec	\N	SIGNUP	curl/8.7.1	::ffff:100.64.0.2	2026-04-19 21:53:56.06+00	\N	bd150de3caa8e8fae6266e340723a5e86116d7370bc915e392c830e0af92ff1c
06427a7c-84c2-4019-b89e-49394dbcfc33	0182f28c-709a-48e5-945e-d8170bc47e06	\N	SIGNUP	Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1	::ffff:100.64.0.3	2026-04-20 12:59:14.275+00	\N	52a219d5ba7bf0cacf007892cd8852fcb6ff7c7de016fa836ef8ad70be31b9e6
5f8ee6bf-b0f0-4a5a-8a1b-a054a39dbce8	0182f28c-709a-48e5-945e-d8170bc47e06	1270a375-c671-4b11-811b-61202548f84f	UPLOAD	Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1	::ffff:100.64.0.5	2026-04-20 13:24:41.851+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	9e29b64be51bc429ae89912af359f13fd36b51bbb042f7638fd94f36d8fc7d5e
fdbc89ea-9b84-4c71-8cf8-64fa0eab255a	0182f28c-709a-48e5-945e-d8170bc47e06	1270a375-c671-4b11-811b-61202548f84f	VIEW	\N	::ffff:100.64.0.9	2026-04-20 13:24:49.644+00	\N	08493e81263fd5f65b41f93d9de131e8cb398f0df797b37037681031e14387b5
2c3ec2c4-cd4b-49c0-9636-5aec505193a8	0182f28c-709a-48e5-945e-d8170bc47e06	1270a375-c671-4b11-811b-61202548f84f	VIEW	\N	::ffff:100.64.0.9	2026-04-20 13:25:23.971+00	\N	b4420bbcd61bfffb3856992e17ad1dee040c759e3a3a63ea5331c6b3f4d043f7
49fb4ddf-efaa-4526-a8f7-fd9431b5e7e8	0182f28c-709a-48e5-945e-d8170bc47e06	\N	LOGIN	Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1	::ffff:100.64.0.15	2026-04-20 13:33:13.1+00	\N	513d2221829bc5244c31226291df0baa0105d99cf81c0f4d2dda7f405b653643
24f1d584-46c2-4c27-a183-acd2ccaac8ad	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	UPLOAD	Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1	::ffff:100.64.0.17	2026-04-20 13:33:37.344+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	a5107a52ab6a2a2f3d6dd0b8a27694d1529fd1c30c174bb6a3b9712b3968515a
6288d3e5-2ee6-4a6b-a732-fc9a74315b1a	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.17	2026-04-20 13:33:43.603+00	\N	821a8a15ba91fd3974fd1bc636a3659a732c8286906dddacb3e58d87990d9bf3
1a6af7c1-f5a9-4933-b14d-1e3dd602d655	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.18	2026-04-20 13:33:53.336+00	\N	cba54269a637611a8c86478f2ad278d796a73f0a2a7a8b8c92eab23fce60e4f7
a8129605-2ead-4fc6-b196-4cb7af36ac99	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.20	2026-04-20 14:39:58.471+00	\N	3ca2507d9d017663331848512f800287c2717f2bc9e63b35e7240cadd36d63fe
d7a4042c-79d3-47e2-93ef-bdb0ebb4c6f8	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.21	2026-04-20 14:44:16.44+00	\N	ce7e431bbc2a6c6fd46a49ca8ec003889fe595850ad121254662d66395b6d169
d569537b-a507-482d-aaf2-8ea3ba1b2b72	0182f28c-709a-48e5-945e-d8170bc47e06	1270a375-c671-4b11-811b-61202548f84f	VIEW	\N	::ffff:100.64.0.15	2026-04-20 14:45:49.169+00	\N	b3b52419659075f9a815a78690ca8a171a2d3cceeb2a7c721e0781de94edbbc2
13b191c2-b1b7-4657-b558-ada897a2c0e9	0182f28c-709a-48e5-945e-d8170bc47e06	1270a375-c671-4b11-811b-61202548f84f	VIEW	\N	::ffff:100.64.0.21	2026-04-20 14:46:46.106+00	\N	81b087f88e0d775ed8d2949432d8d69225684419a2a070c00521e5462c72b129
77761f2e-34e2-4ee1-98a2-d38ca0fb893e	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.11	2026-04-20 14:46:58.494+00	\N	6aab16c1609b81cbd2ed3b886c77359a1e7d2bade112db902f14913ce41625a2
2091fc8c-2fc5-4e86-a642-a54f7367a966	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.11	2026-04-20 14:47:03.699+00	\N	01207c6b8d703da684a5027e442ec8c9a8f1685e37bdefd0814b691f829e39ef
8196c432-e494-405b-9a89-8b3a42973239	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.7	2026-04-20 15:02:43.794+00	\N	582a188133c852697cbb884523d55bbb647a40eb3c239afd13ffec16b8973756
435a3dad-9ed4-40aa-85ee-2e286399526f	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.3	2026-04-20 15:06:54.824+00	\N	1ac5c04226799db4d5d4aabf1e3216c4c20fc19cc41727ddb965781655ea3648
605e6cb2-ec71-408b-aaa8-4857202bcbc6	0182f28c-709a-48e5-945e-d8170bc47e06	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	VIEW	\N	::ffff:100.64.0.7	2026-04-20 15:10:07.113+00	\N	356d4a4cf2cd277a25cf28f334c26e52834541a9a2b231cf342dc2fc939bc746
f9e89af7-8fa1-4e14-87f7-51ba1b974eb4	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.4	2026-04-20 15:10:27.137+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	94ec8084e529a3400989eee1519e0bd5638ec34565a78388be86d657ed6a4954
ac568de1-9d5f-454a-9a28-e87191018dae	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.2	2026-04-20 15:10:35.553+00	\N	3b52ff0c886aa08fdfe7985e500300c08e7774d07478ad250fc510e8fca9530c
70d9a10a-3a72-4a53-be43-462fce3b7c47	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.5	2026-04-20 15:10:41.647+00	\N	e095d74a7f983a2edcd19f7f7601c8034fc5795d96dbeed9159ced76ad777b96
ec2ae369-7f41-436f-98e2-45140dae346d	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.2	2026-04-20 15:16:54.137+00	\N	5e3e46d496b12d4c8f68128864f7e93c0911baf9660e1167144f3b4fdeeaafa5
450fe3e2-fa40-4660-903d-d5ddb7cd136f	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.17	2026-04-20 15:19:29.707+00	\N	e2d160cfba1a94a3d32ad4d8f41820c19729fa9940d1c6525a7f8a8d34e62ab5
cf830d6a-e8b8-445f-b176-f0280b2c6beb	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.13	2026-04-20 15:19:43.623+00	\N	280bd1edcbc145089e8a035374a95d45b715152ea1ecd7ff6b40c8e133b4cb71
926eb3c1-367e-4c58-9d32-3c5d347ec1b8	0182f28c-709a-48e5-945e-d8170bc47e06	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	VIEW	\N	::ffff:100.64.0.9	2026-04-20 15:24:10.337+00	\N	f310395e53c2e36ecc847de020c3e7315fffb64f1aa3f6440251373580732b00
39ad3043-49a7-490e-8a95-7f64a9d8eee9	0182f28c-709a-48e5-945e-d8170bc47e06	e5809226-6570-497f-ba8b-6992bffab29f	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.6	2026-04-20 15:26:00.958+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	cc6642551aaa2935c99e2db51b27eef081a7d4a62c6631d5942d7caeb3971742
d2ea995e-2a3a-44d2-9a15-b836d9f2d469	0182f28c-709a-48e5-945e-d8170bc47e06	e5809226-6570-497f-ba8b-6992bffab29f	VIEW	\N	::ffff:100.64.0.17	2026-04-20 15:26:13.065+00	\N	e8306e134058151d907dcf7f15489aa70794562eae0adb6af605dafe854868b4
7538d61d-fd07-491d-9dd1-01d09089d6a1	0182f28c-709a-48e5-945e-d8170bc47e06	e5809226-6570-497f-ba8b-6992bffab29f	VIEW	\N	::ffff:100.64.0.19	2026-04-20 15:26:17.304+00	\N	5ed44846cb519c2625108a2506eac0094fc0046f70a9ef39ce73001b7ae85a52
b6eeadad-3e66-4230-a2cb-a53807b0dc20	0182f28c-709a-48e5-945e-d8170bc47e06	e5809226-6570-497f-ba8b-6992bffab29f	VIEW	\N	::ffff:100.64.0.21	2026-04-20 15:29:59.541+00	\N	fb6b36ed2b4cdb9a856596e759687db95d036f07ce4a4b84c312d164fcc668b4
9f46696e-b017-429f-8f04-fb6f9ea450da	0182f28c-709a-48e5-945e-d8170bc47e06	30b54481-77b6-433b-9c22-18b49fe19e1f	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.11	2026-04-20 15:34:23.527+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	538a1213179ced0c8543a0e3a5ed535605080644543c0bdd32bad895dfdfc98a
85c37bed-885c-467f-8bea-eb71b2eb2f45	0182f28c-709a-48e5-945e-d8170bc47e06	30b54481-77b6-433b-9c22-18b49fe19e1f	VIEW	\N	::ffff:100.64.0.7	2026-04-20 15:34:38.183+00	\N	b722ebf84ed7a1b96c92176e657f5fdea3d0936c258624cb32217c7c862d1ed3
b9146440-b58a-4dab-b7ce-ed81abe82d2b	0182f28c-709a-48e5-945e-d8170bc47e06	30b54481-77b6-433b-9c22-18b49fe19e1f	VIEW	\N	::ffff:100.64.0.10	2026-04-20 15:35:25.232+00	\N	f59406d3c06d76548405017a7b104377c4b9934c8a3e20a22f1b5ee0a15a8fbf
c0a0f5cf-126c-4040-bb10-d867288e783e	0182f28c-709a-48e5-945e-d8170bc47e06	f99d82eb-47f7-41c7-acc3-f83afa7308c3	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.6	2026-04-20 15:43:15.507+00	{"file_hash": "5f8427a5f79c3ef86ad6f5f464d79aaac334b163b6f13c05b9a8806d7b53a91d", "original_name": "namecheap-order-196200623.pdf"}	db7f88a89d382af4dce2ad531226278de90ab73605e1b5c0210a97ddd497718e
450648b8-acc9-490e-b707-656d5d7f9818	0182f28c-709a-48e5-945e-d8170bc47e06	f99d82eb-47f7-41c7-acc3-f83afa7308c3	VIEW	\N	::ffff:100.64.0.11	2026-04-20 15:44:21.968+00	\N	e6c1f9834e74998eab37f8617041982ed48f5bcfeab5173602316f09db6244db
84994766-44f5-44c1-b098-bc9a8d028638	0182f28c-709a-48e5-945e-d8170bc47e06	c0d4bfbe-408a-4460-a117-c95a893ed86c	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.3	2026-04-20 16:07:02.497+00	{"file_hash": "0b0a06c63b4954b516d5a7c6cce47ede5d62dbe98647912e45e5735a4558fce9", "original_name": "milton leseni.pdf"}	37fcc635b06ca706d46ae25605b140f1c14a13dd38a26e83bb30bb247036eb2c
19c33bfe-6846-42b8-b627-f8d5254879d7	0182f28c-709a-48e5-945e-d8170bc47e06	c0d4bfbe-408a-4460-a117-c95a893ed86c	VIEW	\N	::ffff:100.64.0.16	2026-04-20 16:20:28.16+00	\N	f642107b617fa696fb5ee8ea4f7ac034176458771f26a9a9c6c876862a6eb04f
4785d734-9c89-4bb3-ad01-a16fe5e44612	0182f28c-709a-48e5-945e-d8170bc47e06	c0d4bfbe-408a-4460-a117-c95a893ed86c	VIEW	\N	::ffff:100.64.0.25	2026-04-20 22:09:49.11+00	\N	deb5f1c373421ff04472cf86e6938985805e2826b1e7bbad264ed43dee25fe9f
275bcc78-1295-4adc-96ef-8813e21db188	0182f28c-709a-48e5-945e-d8170bc47e06	\N	LOGIN	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.8	2026-04-21 15:08:12.209+00	\N	d4d07d5f44b9f46c8790877d3cdec41bf81d78f788e56a23232af53836dcdcd7
f01b8e32-fa81-4db9-ac41-383af75622b2	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	UPLOAD	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36	::ffff:100.64.0.10	2026-04-21 15:08:54.459+00	{"file_hash": "bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4", "original_name": "ripoti_kamili_leo_2026_04_01.pdf"}	03155d019160e103be17e4b7683d643da6741269f46d2024ef4f2216bc9df9a6
68d50d6a-8930-4c29-9d7d-44d9c5a866d8	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.7	2026-04-21 15:09:02.506+00	\N	bd2619f4ba8f836496ec85e58a964c0f4957cbdacfdee1f67a1aef3127d38b21
f9ad8471-ece0-4dd0-baf0-ab0423a015d1	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.2	2026-04-21 15:09:08.694+00	\N	b11e09ea6afea95d466f64842f0648cbf2fe9cd0c27307b000c8d4cbd3477a74
e7b3b39f-06dd-4b78-9c96-3db4cca9226b	0182f28c-709a-48e5-945e-d8170bc47e06	\N	LOGIN	Mozilla/5.0 (iPhone; CPU iPhone OS 18_7_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/146.0.7680.151 Mobile/15E148 Safari/604.1	::ffff:100.64.0.11	2026-04-21 15:16:29.999+00	\N	0d4c9b8ad3e163342bc8ce1929e369c97fe860b39c2001d043028188fe21ede0
a86287c3-1760-4c38-88ea-f47d9a028ed4	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.11	2026-04-21 15:16:37.963+00	\N	4b1f0115b4d08afee0a1b704cbd04c5b30e1e19e26cf2ece312a961cc2fc7357
f0c164e0-d24c-4e95-864a-dcf162753652	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.21	2026-04-21 15:17:30.052+00	\N	9dcb134e9a3b8203ea7b2e34421d9dbce197d9e8c94a126ae717d754099b0cb2
d7089c27-4c1d-42c4-8685-21493d1cbc8d	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.14	2026-04-21 15:17:34.101+00	\N	eba5fe37fbfd06ff31d8e1294738cdeb31e125b44bc3996c6f9e3bb255dacc81
9fcccc07-f1d5-468f-b9c0-5606f1c68c12	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.23	2026-04-21 15:18:05.682+00	\N	d7eeb7a6f7c2b9d9f44d743bb54c0ccd14fa8caa2f335353eabe1fa96a183ba1
a5a19770-fcec-4582-bbde-baf1c8cb5e61	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.6	2026-04-22 05:55:06.251+00	\N	4e352ef3cef3932bf921e3a695b6fe520d3e78cf8a3d9c6f82807390a6542dfa
cb870531-c5b8-4dd1-944a-d9a7fd446b99	0182f28c-709a-48e5-945e-d8170bc47e06	d120e9d3-f85e-49ce-a230-bbbed428f540	VIEW	\N	::ffff:100.64.0.14	2026-04-22 06:15:52.612+00	\N	39949b107e1bfafb72cb72791fd11a906a2f08175d0b1d34b0dd3431a011a55d
\.


--
-- Data for Name: document_signers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.document_signers (id, document_id, email, order_num, token, token_expires_at, token_used, status, signed_at, created_at) FROM stdin;
0f9b2d24-277c-4fe1-9a6b-cde2b2668ab5	1270a375-c671-4b11-811b-61202548f84f	mbuhombe@gmail.com	1	f2771b69fa4940eaccb5cbe744e6d288f74abc331e84d9fac268f258e90e97fe	2026-04-23 13:24:42.882+00	f	pending	\N	2026-04-20 13:24:42.869177+00
e6ba711f-d29b-4c64-b278-d1116b863a23	8ce9ee2f-e101-47e5-8a5d-2100e69873ec	mbuhombe@gmail.com	1	13cc35c5e0ea678b8dfce64972f1401af4e81a2fa764c3d6da6b706cc3bd4c4b	2026-04-23 13:33:38.807+00	f	pending	\N	2026-04-20 13:33:38.79511+00
928f178b-4678-4bab-be2a-35bbd172b5e5	6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	mbuhombe@gmail.com	1	e839ab8e702945ce54c833d05d0564cff64727a0c58e15f34c97f4b6cabb0849	2026-04-23 15:10:29.465+00	f	pending	\N	2026-04-20 15:10:29.448028+00
3325a1b6-9e4e-4515-a180-750b7e3b84e1	e5809226-6570-497f-ba8b-6992bffab29f	mbuhombe@gmail.com	1	be65381658ac4776365403e12b178b028d9f60526bd07f033040206dba66fe93	2026-04-23 15:26:02.546+00	f	pending	\N	2026-04-20 15:26:02.531888+00
f4046c0d-5260-4aa0-b32b-977f84df8a42	30b54481-77b6-433b-9c22-18b49fe19e1f	mbuhombe@gmail.com	1	3105477f6f95a19dd224f2722ad4185023a0833d2bce50685956a83f04140e65	2026-04-23 15:34:25.725+00	f	pending	\N	2026-04-20 15:34:25.708218+00
7661f16f-ea2a-4f82-bb84-cccff873fd5f	f99d82eb-47f7-41c7-acc3-f83afa7308c3	mbuhombe@gmail.com	1	7d1d3699dcba6afe09b822567f9bba9e95d5da970da4bbebc1af4822f3ef4ca4	2026-04-23 15:43:16.697+00	f	pending	\N	2026-04-20 15:43:16.679657+00
fbc62198-2947-408f-b0a5-2a3873fefa56	c0d4bfbe-408a-4460-a117-c95a893ed86c	mbuhombe@gmail.com	1	c73a2c95ba40bb247e16dcb08f4c945856716635d6d2e8a3d0c55870e21bc326	2026-04-23 16:07:03.521+00	f	pending	\N	2026-04-20 16:07:03.504739+00
e9d3e690-71ec-4a47-8318-2abaf09c9853	d120e9d3-f85e-49ce-a230-bbbed428f540	mbuhombe@gmail.com	1	f10c07021359b20b14722d055235a95f793d273eb8d05bb7e722fd2c2f612dc4	2026-04-25 06:16:59.953+00	f	pending	\N	2026-04-21 15:08:56.030821+00
\.


--
-- Data for Name: documents; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.documents (id, user_id, original_name, file_path, status, recipient_email, recipient_token, created_at, recipient_token_expires_at, recipient_token_used, orig_file_path, is_deleted, file_hash, signed_at, signed_by, cloudinary_public_id, orig_cloudinary_public_id, current_signer_order, total_signers, signing_complete) FROM stdin;
1270a375-c671-4b11-811b-61202548f84f	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776691481/securesign/documents/25eceb67-18ea-43f8-b283-fdc692f93170	pending	\N	\N	2026-04-20 13:24:41.846571+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/25eceb67-18ea-43f8-b283-fdc692f93170	\N	1	1	f
8ce9ee2f-e101-47e5-8a5d-2100e69873ec	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776692016/securesign/documents/b26cb7fd-7246-4dcb-bf82-689b873e429e	pending	\N	\N	2026-04-20 13:33:37.34064+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/b26cb7fd-7246-4dcb-bf82-689b873e429e	\N	1	1	f
6dfcaac4-9e2c-4227-b7b5-2fbe78765b0f	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776697826/securesign/documents/e5699060-76da-4674-8e5f-56bcd4359e97	pending	\N	\N	2026-04-20 15:10:27.133074+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/e5699060-76da-4674-8e5f-56bcd4359e97	\N	1	1	f
e5809226-6570-497f-ba8b-6992bffab29f	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776698760/securesign/documents/7148a8c1-54d2-4a99-bc8a-01a3ba721c2d	pending	\N	\N	2026-04-20 15:26:00.951919+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/7148a8c1-54d2-4a99-bc8a-01a3ba721c2d	\N	1	1	f
30b54481-77b6-433b-9c22-18b49fe19e1f	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776699263/securesign/documents/2c4b1868-133b-4d25-a27b-7d23b97b2600	pending	\N	\N	2026-04-20 15:34:23.523013+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/2c4b1868-133b-4d25-a27b-7d23b97b2600	\N	1	1	f
f99d82eb-47f7-41c7-acc3-f83afa7308c3	0182f28c-709a-48e5-945e-d8170bc47e06	namecheap-order-196200623.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776699795/securesign/documents/5bfd132c-dad7-471c-b77f-574f92541bb9	pending	\N	\N	2026-04-20 15:43:15.501797+00	\N	f	\N	f	5f8427a5f79c3ef86ad6f5f464d79aaac334b163b6f13c05b9a8806d7b53a91d	\N	\N	securesign/documents/5bfd132c-dad7-471c-b77f-574f92541bb9	\N	1	1	f
c0d4bfbe-408a-4460-a117-c95a893ed86c	0182f28c-709a-48e5-945e-d8170bc47e06	milton leseni.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776701221/securesign/documents/c2f6deb8-64cc-4bc0-a922-3182f1e489e4	pending	\N	\N	2026-04-20 16:07:02.492668+00	\N	f	\N	f	0b0a06c63b4954b516d5a7c6cce47ede5d62dbe98647912e45e5735a4558fce9	\N	\N	securesign/documents/c2f6deb8-64cc-4bc0-a922-3182f1e489e4	\N	1	1	f
d120e9d3-f85e-49ce-a230-bbbed428f540	0182f28c-709a-48e5-945e-d8170bc47e06	ripoti_kamili_leo_2026_04_01.pdf	https://res.cloudinary.com/dueqtqc4p/raw/upload/v1776784134/securesign/documents/5eb1139d-6b3e-4d71-b825-6f8c5e295fc5	pending	\N	\N	2026-04-21 15:08:54.455141+00	\N	f	\N	f	bd200e4011908705c8826a4935590b415894d4aa78ec73ae8f0df15be4d771c4	\N	\N	securesign/documents/5eb1139d-6b3e-4d71-b825-6f8c5e295fc5	\N	1	1	f
\.


--
-- Data for Name: plans; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.plans (id, name, price_usd, max_docs_month, max_signers, max_storage_mb, can_audit_log, can_bulk_send, is_active, created_at) FROM stdin;
1	free	0.00	5	1	100	f	f	t	2026-04-16 12:56:02.480906+00
2	starter	9.99	50	3	1000	t	f	t	2026-04-16 12:56:02.480906+00
3	pro	29.99	200	10	5000	t	t	t	2026-04-16 12:56:02.480906+00
4	enterprise	99.99	999	99	20000	t	t	t	2026-04-16 12:56:02.480906+00
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.refresh_tokens (id, user_id, token_hash, expires_at, revoked, created_at) FROM stdin;
358b79e5-5a1b-49fa-a46b-4a1af20b45a8	df58c25f-3c67-4d3b-b53b-75d6c18a49ec	5eb7e5bde4e60e90218881ef0924f4d372cfd86274457e878a9df8a02716a930	2026-04-26 21:53:56.202+00	f	2026-04-19 21:53:56.204358+00
b5a8ccfb-9fe8-4a69-8736-138deb020f7f	0182f28c-709a-48e5-945e-d8170bc47e06	aac069dd771541f2728cd0c9936d6abb5e6a24599ed56c61eed20293b3052c65	2026-04-27 12:59:14.403+00	t	2026-04-20 12:59:14.406178+00
a5828424-5504-42d6-83cc-85ebbd1ff456	0182f28c-709a-48e5-945e-d8170bc47e06	270b6468f75023acb059736ece628f1a822651314690a14b6a307e6272de58e0	2026-04-27 13:00:31.961+00	t	2026-04-20 13:00:31.963699+00
79a9c7f6-bafc-4695-8cfc-f5348f458d16	0182f28c-709a-48e5-945e-d8170bc47e06	c228aac6a21b7ae819cdbf1bd182db88a4ae87a02ddd789d1a5e8a6889a275e9	2026-04-27 13:24:40.223+00	f	2026-04-20 13:24:40.225235+00
efb5cbe1-0e62-409b-a8f8-b5badeee7826	0182f28c-709a-48e5-945e-d8170bc47e06	5831d49b138f00899da55ec16d0e007b16677e7b78cd1b545e43f00207f1a292	2026-04-27 13:33:13.107+00	t	2026-04-20 13:33:13.110026+00
163e25a9-680e-47b8-a212-4346327c04c5	0182f28c-709a-48e5-945e-d8170bc47e06	ce3693db3f757c15282c9d9ccefa39a2a0e7e56df10703f86d09f2cec1e6abd3	2026-04-27 13:33:52.701+00	t	2026-04-20 13:33:52.703059+00
907d1ef0-46c2-4f63-a6e3-7f794bdfe841	0182f28c-709a-48e5-945e-d8170bc47e06	bb8d9245679b2ac8e679f87da6b9af3ed285c945c4ed56dd4918e864c99e1755	2026-04-27 14:39:57.834+00	t	2026-04-20 14:39:57.836658+00
84b4a0f0-1c80-481f-a5b6-b795f3fccfdb	0182f28c-709a-48e5-945e-d8170bc47e06	0ed8798e605e35e66b2899dc84ac5372f7906851ed58914c92afef281b7af96d	2026-04-27 15:02:43.135+00	t	2026-04-20 15:02:43.135728+00
5f011e63-ded9-48db-be01-2c3ce88fcd12	0182f28c-709a-48e5-945e-d8170bc47e06	c03566db7774b7f5ff9f6e3f735ed344a3ea02725664c58f3ef894d68f9f8d92	2026-04-27 15:19:29.133+00	t	2026-04-20 15:19:29.134642+00
cb08b308-6678-40ff-83a5-86adc5bb2c3b	0182f28c-709a-48e5-945e-d8170bc47e06	e7f5722a72762244803e8bdc08d4a94e76298b4dfa35e3621a47e721aa298f19	2026-04-27 15:19:30.597+00	t	2026-04-20 15:19:30.598325+00
bf08045e-268c-45c5-b60e-9a9713da855b	0182f28c-709a-48e5-945e-d8170bc47e06	23e459080ce59ad8af073ed2a3db5742b27917e6996988a8a2a4bd1c6ae266bf	2026-04-27 15:34:37.45+00	t	2026-04-20 15:34:37.452078+00
ab13af39-ea26-4278-a7c5-1d441dafd301	0182f28c-709a-48e5-945e-d8170bc47e06	7f799ddd6912ed4f1b444a483fc0648c637a72d8b5b10c03857618df784985b1	2026-04-27 15:51:19.88+00	t	2026-04-20 15:51:19.883242+00
d13b80e1-500d-4679-abf0-fb2a539d0bee	0182f28c-709a-48e5-945e-d8170bc47e06	9ebea41d6de6f48c379c9976e5e03339f25e8fe48eb51a77b3b69b438e0a21f4	2026-04-27 16:06:54.692+00	t	2026-04-20 16:06:54.694904+00
009b11d9-24d1-449d-abe7-a66bea94e3f5	0182f28c-709a-48e5-945e-d8170bc47e06	57bb7dbe2a4660155f341a8c5d1480b843cc868b8e3aceb637ff1c7eb82a8e58	2026-04-27 16:25:05.887+00	t	2026-04-20 16:25:05.890026+00
fc08672d-3ef0-4aa1-a46b-e62dd8f2e16f	0182f28c-709a-48e5-945e-d8170bc47e06	9fa8b6e383998a6d1e35d347ecfa6109670f3e56949aecd2a23ab2507fbee763	2026-04-27 16:25:06.783+00	t	2026-04-20 16:25:06.785647+00
2011e6cb-17b8-422b-ac2c-82ff28f7b782	0182f28c-709a-48e5-945e-d8170bc47e06	a0f9b6efe83fade1586989db1acf98f64b03949c3820ec687be0417cee64c08c	2026-04-27 22:09:39.22+00	t	2026-04-20 22:09:39.221516+00
65a4e287-2250-46b1-9f52-f3d9035a1b04	0182f28c-709a-48e5-945e-d8170bc47e06	cbf3c40f99a05a2acd64b2d7207236db3a304d8c8a13a139d345be3641116284	2026-04-28 15:07:43.04+00	f	2026-04-21 15:07:43.042735+00
b34667ad-28de-4f70-8805-a0e05861c700	0182f28c-709a-48e5-945e-d8170bc47e06	6b443dada51cc84af9a57ebdd8f1067c62edf41cb21d5a32a1681c2428c47786	2026-04-28 15:16:30.008+00	f	2026-04-21 15:16:30.010328+00
73f29ca2-cad4-4d10-aaa6-09cbd4f1b91b	0182f28c-709a-48e5-945e-d8170bc47e06	5307ccbedcb6fa332d92d881afc0f3696d251f31f2126277e9eb9b13add96e16	2026-04-28 15:08:12.217+00	t	2026-04-21 15:08:12.221181+00
3c3061c2-06d9-45ea-906e-8507b620ef52	0182f28c-709a-48e5-945e-d8170bc47e06	feff3ea7a9a899f0886f6ace4aa2b57fbe8f6cfea603e3014a8dfc308def2430	2026-04-28 15:37:17.277+00	t	2026-04-21 15:37:17.280528+00
d51d5e92-fe95-4edf-838c-0797c46a24d7	0182f28c-709a-48e5-945e-d8170bc47e06	9dc7bb6d5587011e26c16572556411b50ff4bdb3ad3746a4f7cf7fa37f1b72db	2026-04-28 15:37:23.188+00	t	2026-04-21 15:37:23.191056+00
6dc4a4d3-91fc-493e-9474-3ccc791aa05c	0182f28c-709a-48e5-945e-d8170bc47e06	72b0a50782fd0fcd7c0c483bc15840ec8d42466200304cff13117a24762fc87d	2026-04-28 18:41:11.821+00	t	2026-04-21 18:41:11.823598+00
81ef4241-a1f7-4638-8a4a-38adb95a9558	0182f28c-709a-48e5-945e-d8170bc47e06	253a4ddf6810695a5b2d40adf9df31636bd8994fe53e94c8f575d0b67d189625	2026-04-28 18:41:12.841+00	t	2026-04-21 18:41:12.843808+00
68a7eff9-bb15-4baa-9c65-0eeedfb9622b	0182f28c-709a-48e5-945e-d8170bc47e06	9937d5e6134e821819c365fcd0c2f785d33bdb3d19d28cd782881a71a645cd9e	2026-04-29 05:49:47.949+00	t	2026-04-22 05:49:47.951557+00
844e2b5e-f085-4e19-bc8f-6dbd01e7329a	0182f28c-709a-48e5-945e-d8170bc47e06	e4238b2fe87671121572158ccf1f63394be6b53ebff08e3e1e1458304cbd61eb	2026-04-29 06:15:51.953+00	f	2026-04-22 06:15:51.956289+00
\.


--
-- Data for Name: signatures; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.signatures (id, document_id, user_id, signer_email, signature_hash, sig_x, sig_y, sig_width, sig_height, page_number, verified, verification_method, signed_at, crypto_signature, document_hash) FROM stdin;
\.


--
-- Data for Name: subscriptions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, payment_ref, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, email, password_hash, profile_photo, created_at, is_suspended, is_admin, suspended_at, suspend_reason, is_deleted, deleted_at, mfa_enabled, mfa_secret, mfa_secret_pending, failed_attempts, lockout_until, email_verified, email_verification_token, email_verification_sent_at, password_reset_token, password_reset_expires_at, public_key, private_key_enc) FROM stdin;
df58c25f-3c67-4d3b-b53b-75d6c18a49ec	test123@gmail.com	$2a$12$xIj8eM31Lq54uJeRb/.F5O.edQvy4YxbAGT3C9YnfMFY6.K1su8ZK	\N	2026-04-19 21:53:56.053344+00	f	f	\N	\N	f	\N	f	\N	\N	0	\N	t	00f0b7f8b121b8efe16997566f094727d77e5ad1519898d544c6f2ec7624f6c3	2026-04-19 21:53:56.051+00	\N	\N	\N	\N
0182f28c-709a-48e5-945e-d8170bc47e06	mbuhombe44@gmail.com	$2a$12$UZcx95RCNr3wfrBQ77eLL.q4Yl4pZ8BWvIbTd4XQDvfQNu4JC/p.q	\N	2026-04-20 12:59:14.270351+00	f	f	\N	\N	f	\N	f	\N	\N	0	\N	t	9b66f6f474f7ce7e59945be743d0aab29d1dd289e71ed56037c300e4caa0e21c	2026-04-20 12:59:14.267+00	\N	\N	\N	\N
\.


--
-- Name: admin_roles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.admin_roles_id_seq', 9, true);


--
-- Name: plans_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.plans_id_seq', 12, true);


--
-- Name: admin_logs admin_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_logs
    ADD CONSTRAINT admin_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_roles admin_roles_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_roles
    ADD CONSTRAINT admin_roles_name_key UNIQUE (name);


--
-- Name: admin_roles admin_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_roles
    ADD CONSTRAINT admin_roles_pkey PRIMARY KEY (id);


--
-- Name: admins admins_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_email_key UNIQUE (email);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: document_signers document_signers_document_id_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_signers
    ADD CONSTRAINT document_signers_document_id_email_key UNIQUE (document_id, email);


--
-- Name: document_signers document_signers_document_id_order_num_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_signers
    ADD CONSTRAINT document_signers_document_id_order_num_key UNIQUE (document_id, order_num);


--
-- Name: document_signers document_signers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_signers
    ADD CONSTRAINT document_signers_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: plans plans_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_name_key UNIQUE (name);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: signatures signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_admin_logs_admin_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_admin_logs_admin_id ON public.admin_logs USING btree (admin_id);


--
-- Name: idx_admin_logs_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_admin_logs_created ON public.admin_logs USING btree (created_at DESC);


--
-- Name: idx_audit_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_document_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_document_id ON public.audit_logs USING btree (document_id);


--
-- Name: idx_audit_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_timestamp ON public.audit_logs USING btree ("timestamp" DESC);


--
-- Name: idx_audit_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_document_signers_document; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_signers_document ON public.document_signers USING btree (document_id);


--
-- Name: idx_document_signers_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_signers_status ON public.document_signers USING btree (status);


--
-- Name: idx_document_signers_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_signers_token ON public.document_signers USING btree (token);


--
-- Name: idx_documents_not_deleted; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_documents_not_deleted ON public.documents USING btree (user_id) WHERE (is_deleted = false);


--
-- Name: idx_documents_signed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_documents_signed_at ON public.documents USING btree (signed_at DESC) WHERE (signed_at IS NOT NULL);


--
-- Name: idx_documents_token_expiry; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_documents_token_expiry ON public.documents USING btree (recipient_token_expires_at) WHERE (recipient_token_expires_at IS NOT NULL);


--
-- Name: idx_documents_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_documents_user_id ON public.documents USING btree (user_id);


--
-- Name: idx_refresh_tokens_expires; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_expires ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_hash; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_user ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_signatures_document; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_signatures_document ON public.signatures USING btree (document_id);


--
-- Name: idx_signatures_document_hash; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_signatures_document_hash ON public.signatures USING btree (document_hash);


--
-- Name: idx_signatures_signer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_signatures_signer ON public.signatures USING btree (signer_email);


--
-- Name: idx_subscriptions_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_subscriptions_user ON public.subscriptions USING btree (user_id);


--
-- Name: idx_users_email_verification_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_email_verification_token ON public.users USING btree (email_verification_token) WHERE (email_verification_token IS NOT NULL);


--
-- Name: idx_users_password_reset_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_password_reset_token ON public.users USING btree (password_reset_token) WHERE (password_reset_token IS NOT NULL);


--
-- Name: audit_logs trg_audit_logs_immutable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_audit_logs_immutable BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();


--
-- Name: admin_logs admin_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_logs
    ADD CONSTRAINT admin_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: admins admins_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.admin_roles(id);


--
-- Name: audit_logs audit_logs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_signers document_signers_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_signers
    ADD CONSTRAINT document_signers_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE RESTRICT;


--
-- Name: documents documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: signatures signatures_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: signatures signatures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id);


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict ggMcybZilixviIHqfqo0CCeKNUaqa0WjUhbroc7kgx9ZSTJNVIqyJ9phOYaHIAK

